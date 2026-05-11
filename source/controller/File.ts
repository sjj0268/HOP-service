import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import multer from '@koa/multer';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, isAbsolute, normalize, resolve, sep } from 'path';
import {
    Authorized,
    Controller,
    CurrentUser,
    Delete,
    HttpCode,
    HttpError,
    OnUndefined,
    Param,
    Post,
    Put,
    QueryParam,
    Req,
    UseBefore
} from 'routing-controllers';
import { ResponseSchema } from 'routing-controllers-openapi';

import { dataSource, OAuthCredential, resolveOAuthPlatformByHost, SignedLink, User } from '../model';
import { AWS_S3_BUCKET, AWS_S3_PUBLIC_HOST, s3Client } from '../utility';

const uploadMiddleware = multer({ storage: multer.memoryStorage() });
const GIT_UPLOAD_TIMEOUT = 5 * 60 * 1000;
const MAX_ERROR_LINES = 3;

const sanitizePathInput = (path: string) => {
    const normalizedPath = normalize(path).replace(/^[\\/]+/g, '');

    if (
        !normalizedPath ||
        normalizedPath === '.' ||
        normalizedPath.startsWith('..') ||
        isAbsolute(normalizedPath)
    )
        throw new HttpError(422, `Invalid file path: ${path}`);

    return normalizedPath;
};

const resolveSafePath = (basePath: string, path: string) => {
    const normalizedPath = sanitizePathInput(path);
    const targetPath = resolve(basePath, normalizedPath);

    if (targetPath !== basePath && !targetPath.startsWith(`${basePath}${sep}`))
        throw new HttpError(422, `Invalid file path: ${path}`);

    return targetPath;
};

const normalizeRelativePath = (path: string) => sanitizePathInput(path);

const sanitizeGitError = (message: string, accessToken: string) =>
    message
        .replaceAll(accessToken, '***')
        .replaceAll(encodeURIComponent(accessToken), '***')
        .replace(/\/\/[^/@\s]+@/g, '//***@')
        .trim();

@Controller('/file')
export class FileController {
    credentialStore = dataSource.getRepository(OAuthCredential);

    @Post('/signed-link/:path(.*)')
    @Authorized()
    @HttpCode(201)
    @ResponseSchema(SignedLink)
    async createSignedLink(
        @CurrentUser() { id }: User,
        @Param('path') path: string
    ) {
        const Key = `user/${id}/${path}`;

        const command = new PutObjectCommand({ Bucket: AWS_S3_BUCKET, Key });

        const putLink = await getSignedUrl(s3Client, command);

        return { putLink, getLink: `${AWS_S3_PUBLIC_HOST}/${Key}` };
    }

    @Delete('/:path(.*)')
    @Authorized()
    @OnUndefined(204)
    async deleteFile(@CurrentUser() { id }: User, @Param('path') path: string) {
        const Key = `user/${id}/${path}`;

        const command = new DeleteObjectCommand({ Bucket: AWS_S3_BUCKET, Key });

        await s3Client.send(command);
    }

    @Put('/Git/:noProtocolURL(.*)')
    @Authorized()
    @HttpCode(201)
    @UseBefore(uploadMiddleware.any())
    async uploadFilesToGit(
        @CurrentUser() user: User,
        @Param('noProtocolURL') noProtocolURL: string,
        @QueryParam('branch') branch = 'main',
        @QueryParam('folder') folder?: string,
        @Req() request?: { files?: { fieldname: string; buffer: Buffer }[] }
    ) {
        const files = request?.files;

        if (!files?.length) throw new HttpError(422, 'No files uploaded');

        let repositoryURL: URL;
        try {
            repositoryURL = new URL(`https://${noProtocolURL}`);
        } catch {
            throw new HttpError(422, 'Invalid Git repository URL');
        }

        const platform = resolveOAuthPlatformByHost(repositoryURL.hostname);

        if (!platform) throw new HttpError(422, `Unsupported Git platform: ${repositoryURL.hostname}`);

        const credential = await this.credentialStore.findOneBy({
            platform,
            user: { id: user.id }
        });

        if (!credential) throw new HttpError(403, `Missing ${platform} OAuth credential`);
        if (!credential.username) throw new HttpError(422, `${platform} OAuth username is required`);
        if (!branch.trim()) throw new HttpError(422, 'Branch is required');

        repositoryURL.username = credential.username;
        repositoryURL.password = credential.accessToken;

        const targetFolder = folder ? normalizeRelativePath(folder) : undefined;
        const tempRoot = await mkdtemp(resolve(tmpdir(), 'hop-git-upload-'));

        try {
            for (const file of files) {
                const filePath = resolveSafePath(tempRoot, file.fieldname);

                await mkdir(dirname(filePath), { recursive: true });
                await writeFile(filePath, file.buffer);
            }

            await new Promise<void>((resolveUpload, rejectUpload) => {
                const localCLI = resolve(process.cwd(), 'node_modules/.bin/xgit');
                const localScript = resolve(process.cwd(), 'node_modules/git-utility/dist/index.js');
                const uploadArguments = [
                    'upload',
                    tempRoot,
                    repositoryURL.toString(),
                    branch,
                    targetFolder
                ].filter((item): item is string => Boolean(item));
                let gitUtilityCLI = localCLI;
                let gitUtilityArguments = uploadArguments;

                if (!existsSync(localCLI)) {
                    if (existsSync(localScript)) {
                        gitUtilityCLI = process.execPath;
                        gitUtilityArguments = [localScript, ...uploadArguments];
                    } else {
                        gitUtilityCLI = 'xgit';
                    }
                }
                execFile(
                    gitUtilityCLI,
                    gitUtilityArguments,
                    { timeout: GIT_UPLOAD_TIMEOUT },
                    (error, stdout, stderr) => {
                        if (!error) return resolveUpload();

                        rejectUpload(
                            new Error(`${error.message}\n${stderr || stdout || ''}`.trim())
                        );
                    }
                );
            });
        } catch (error) {
            const detail = sanitizeGitError(
                error instanceof Error ? error.message : String(error),
                credential.accessToken
            );
            const reason = detail.split('\n').slice(0, MAX_ERROR_LINES).join(' | ');

            console.error('Git upload failed:', detail);

            throw new HttpError(500, `Git upload failed: ${reason}`);
        } finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    }
}
