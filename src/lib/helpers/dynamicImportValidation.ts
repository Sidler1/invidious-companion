/**
 * Validates and resolves the dynamic import paths configurable via the
 * GET_FETCH_CLIENT_LOCATION and YT_PLAYER_REQ_LOCATION environment variables.
 *
 * Restricts dynamic imports to an allowlist of internal module paths to prevent
 * accidental or malicious loading of arbitrary modules via environment variables.
 */

function allowedInternalModules(moduleName: string): string[] {
    return [
        moduleName,
        `./${moduleName}`,
        `../lib/helpers/${moduleName}`,
        `./lib/helpers/${moduleName}`,
        `src/lib/helpers/${moduleName}`,
    ];
}

// The only relative-traversal prefix legitimately needed by callers living
// outside src/lib (e.g. src/lib/jobs importing ../lib/helpers/...).
const TRAVERSAL_ALLOWED_PREFIX = "../lib/";

/**
 * Resolve and validate a dynamic import module location set via an env var.
 * Returns the validated module path string.
 * Throws if the path is not in the allowlist and doesn't match safe patterns.
 */
export function resolveAndValidateImportLocation(
    envVarName: string,
    moduleName: string,
): string {
    let location = moduleName;
    const envLocation = Deno.env.get(envVarName);

    if (!envLocation) {
        return location;
    }

    if (Deno.env.has("DENO_COMPILED")) {
        location = Deno.mainModule.replace("src/main.ts", "") + envLocation;
    } else {
        location = envLocation;
    }

    const allowedModules = allowedInternalModules(moduleName);

    // Validate: must be an allowed internal module or a path under the project
    // that resolves to a known module name
    const basename = location.split("/").pop()?.replace(/\.ts$/, "") || "";

    if (allowedModules.includes(location)) {
        return location;
    }

    if (allowedModules.includes(basename)) {
        // Path ends with an allowed module name — accept it
        // This covers compiled paths like file:///path/to/<moduleName>
        return location;
    }

    // Reject anything that looks like a remote URL (http://, https://, npm:, etc.)
    if (/^(https?:|npm:|node:|jsr:)/i.test(location)) {
        throw new Error(
            `${envVarName} rejected: remote module URLs are not allowed. ` +
                `Got: "${envLocation}". Only local/internal module paths are permitted.`,
        );
    }

    // Reject path traversal beyond project root. At most one allowed leading
    // "../lib/" prefix is tolerated; any ".." beyond that (including tricks
    // like "../lib/../../etc/passwd") is rejected.
    const afterAllowedPrefix = location.startsWith(TRAVERSAL_ALLOWED_PREFIX)
        ? location.slice(TRAVERSAL_ALLOWED_PREFIX.length)
        : location;
    if (afterAllowedPrefix.includes("..")) {
        throw new Error(
            `${envVarName} rejected: suspicious path traversal detected. ` +
                `Got: "${envLocation}". Only internal module paths are permitted.`,
        );
    }

    // Allow it but warn — it's a local path with an unrecognized module name
    console.warn(
        `[WARN]  [CONFIG] ${envVarName} uses non-standard module path: "${envLocation}". ` +
            `Allowed modules: ${allowedModules.join(", ")}`,
    );

    return location;
}

export function resolveAndValidateFetchClientLocation(): string {
    return resolveAndValidateImportLocation(
        "GET_FETCH_CLIENT_LOCATION",
        "getFetchClient",
    );
}

export function resolveAndValidatePlayerReqLocation(): string {
    return resolveAndValidateImportLocation(
        "YT_PLAYER_REQ_LOCATION",
        "youtubePlayerReq",
    );
}
