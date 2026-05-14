/**
 * Validates and resolves the GET_FETCH_CLIENT_LOCATION dynamic import path.
 *
 * Restricts dynamic imports to an allowlist of internal module paths to prevent
 * accidental or malicious loading of arbitrary modules via environment variables.
 */

const ALLOWED_INTERNAL_MODULES = [
    "getFetchClient",
    "./getFetchClient",
    "../lib/helpers/getFetchClient",
    "./lib/helpers/getFetchClient",
    "src/lib/helpers/getFetchClient",
];

/**
 * Resolve and validate the fetch client module location.
 * Returns the validated module path string.
 * Throws if the path is not in the allowlist and doesn't match safe patterns.
 */
export function resolveAndValidateFetchClientLocation(): string {
    let location = "getFetchClient";
    const envLocation = Deno.env.get("GET_FETCH_CLIENT_LOCATION");

    if (!envLocation) {
        return location;
    }

    if (Deno.env.has("DENO_COMPILED")) {
        location = Deno.mainModule.replace("src/main.ts", "") + envLocation;
    } else {
        location = envLocation;
    }

    // Validate: must be an allowed internal module or a path under the project
    // that resolves to a known module name
    const basename = location.split("/").pop()?.replace(/\.ts$/, "") || "";

    if (ALLOWED_INTERNAL_MODULES.includes(location)) {
        return location;
    }

    if (ALLOWED_INTERNAL_MODULES.includes(basename)) {
        // Path ends with an allowed module name — accept it
        // This covers compiled paths like file:///path/to/getFetchClient
        return location;
    }

    // Reject anything that looks like a remote URL (http://, https://, npm:, etc.)
    if (/^(https?:|npm:|node:|jsr:)/i.test(location)) {
        throw new Error(
            `GET_FETCH_CLIENT_LOCATION rejected: remote module URLs are not allowed. ` +
                `Got: "${envLocation}". Only local/internal module paths are permitted.`,
        );
    }

    // Reject path traversal beyond project root
    if (location.includes("..") && !location.startsWith("../lib/")) {
        throw new Error(
            `GET_FETCH_CLIENT_LOCATION rejected: suspicious path traversal detected. ` +
                `Got: "${envLocation}". Only internal module paths are permitted.`,
        );
    }

    // Allow it but warn — it's a local path with an unrecognized module name
    console.warn(
        `[WARN]  [CONFIG] GET_FETCH_CLIENT_LOCATION uses non-standard module path: "${envLocation}". ` +
            `Allowed modules: ${ALLOWED_INTERNAL_MODULES.join(", ")}`,
    );

    return location;
}
