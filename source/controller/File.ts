import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import multer from '@koa/multer';
import {
    Authorized,
    BadRequestError,
    Controller,
    CurrentUser,
    Delete,
    ForbiddenError,
    HttpCode,
    InternalServerError,
    OnUndefined,
    Param,
    Post,
    Put,
    QueryParam,
    Req,
    UnprocessableEntityError,
    UseBefore
} from 'routing-controllers';
import { ResponseSchema } from 'routing-controllers-openapi';
import { $, fs, os, path } from 'zx';

import { dataSource, OAuthCredential, resolveOAuthPlatformByHost, SignedLink, User } from '../model';
import { AWS_S3_BUCKET, AWS_S3_PUBLIC_HOST, s3Client } from '../utility';

const MAX_ERROR_LINES = 3;
const uploadMiddleware = multer({
    storage: multer.diskStorage({
        destination: os.tmpdir(),
        filename: (_request, file, callback) =>
            callback(
                null,
                `hop-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`
            )
    })
});

const hasControlCharacter = (text: string) =>
    [...text].some(character => {
        const code = character.charCodeAt(0);

        return code < 32 || code === 127;
    });
const MAX_UPLOAD_FILE_PATH_LENGTH = 512;

const sanitizePathInput = (inputPath: string) => {
    if (inputPath.length > MAX_UPLOAD_FILE_PATH_LENGTH)
        throw new UnprocessableEntityError(`Invalid file path: ${inputPath}`);

    const normalizedPath = path.normalize(inputPath).replace(/^[\\/]+/g, '');

    if (
        !normalizedPath ||
        normalizedPath === '.' ||
        normalizedPath.startsWith('..') ||
        hasControlCharacter(normalizedPath) ||
        path.isAbsolute(normalizedPath)
    )
        throw new UnprocessableEntityError(`Invalid file path: ${inputPath}`);

    return normalizedPath;
};

const resolveSafePath = (basePath: string, inputPath: string) => {
    const normalizedPath = sanitizePathInput(inputPath);
    const targetPath = path.resolve(basePath, normalizedPath);

    if (targetPath !== basePath && !targetPath.startsWith(`${basePath}${path.sep}`))
        throw new UnprocessableEntityError(`Invalid file path: ${inputPath}`);

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
        @Req() request?: { files?: Express.Multer.File[] }
    ) {
        const files = request?.files;

        if (!files?.length) throw new BadRequestError('No files uploaded');

        let repositoryURL: URL;
        try {
            repositoryURL = new URL(`https://${noProtocolURL}`);
        } catch {
            throw new UnprocessableEntityError('Invalid Git repository URL');
        }

        const platform = resolveOAuthPlatformByHost(repositoryURL.hostname);

        if (!platform)
            throw new UnprocessableEntityError(
                `Unsupported Git platform: ${repositoryURL.hostname}`
            );

        const credential = await this.credentialStore.findOneBy({
            platform,
            user: { id: user.id }
        });

        if (!credential) throw new ForbiddenError(`Missing ${platform} OAuth credential`);
        if (!branch.trim()) throw new UnprocessableEntityError('Branch is required');

        repositoryURL.username = credential.username;
        repositoryURL.password = credential.accessToken;

        const targetFolder = folder ? normalizeRelativePath(folder) : undefined;
        const tempRoot = await fs.mkdtemp(path.resolve(os.tmpdir(), 'hop-git-upload-'));
        const uploadedTempPaths = files.map(({ path }) => path);

        try {
            for (const file of files) {
                const filePath = resolveSafePath(tempRoot, file.fieldname);

                await fs.mkdirp(path.dirname(filePath));
                await fs.move(file.path, filePath, { overwrite: true });
            }
            if (targetFolder)
                await $({
                    quiet: true
                })`npx xgit upload ${tempRoot} ${repositoryURL} ${branch} ${targetFolder}`;
            else
                await $({
                    quiet: true
                })`npx xgit upload ${tempRoot} ${repositoryURL} ${branch}`;
        } catch (error) {
            const detail = sanitizeGitError(
                error instanceof Error
                    ? `${error.message}\n${(error as { stderr?: string }).stderr ?? ''}`
                    : String(error),
                credential.accessToken
            );
            const reason = detail.split('\n').slice(0, MAX_ERROR_LINES).join(' | ');

            console.error('Git upload failed:', detail);

            throw new InternalServerError(`Git upload failed: ${reason}`);
        } finally {
            for (const uploadPath of uploadedTempPaths) await fs.remove(uploadPath);
            await fs.remove(tempRoot);
        }
    }
}
