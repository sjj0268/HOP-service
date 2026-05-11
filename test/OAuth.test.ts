import { OAuthPlatform, OAuthPlatformHostMap, resolveOAuthPlatformByHost } from '../source/model/OAuth';

describe('OAuth platform host mapping', () => {
    it('should map OAuth platforms to expected host names', () => {
        expect(OAuthPlatformHostMap).toEqual({
            [OAuthPlatform.GitHub]: 'github.com',
            [OAuthPlatform.GitLab]: 'gitlab.com',
            [OAuthPlatform.CNB]: 'cnb.cool'
        });
    });

    it('should resolve platform by host and subdomain', () => {
        expect(resolveOAuthPlatformByHost('github.com')).toBe(OAuthPlatform.GitHub);
        expect(resolveOAuthPlatformByHost('api.gitlab.com')).toBe(OAuthPlatform.GitLab);
        expect(resolveOAuthPlatformByHost('cnb.cool')).toBe(OAuthPlatform.CNB);
        expect(resolveOAuthPlatformByHost('example.com')).toBeUndefined();
    });
});
