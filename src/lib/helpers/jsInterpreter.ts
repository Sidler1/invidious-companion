import { Platform, Types } from "youtubei.js";

// https://ytjs.dev/guide/getting-started.html#providing-a-custom-javascript-interpreter
// deno-lint-ignore require-await
export const jsInterpreter = Platform.shim.eval = async (
    data: Types.BuildScriptResult,
    env: Record<string, Types.VMPrimative>,
) => {
    const properties = [];

    // JSON.stringify produces a safely-escaped JS string literal. Plain
    // interpolation ("${env.n}") would allow a value containing a quote or
    // paren to break out of the string and inject arbitrary code into the
    // Function body below.
    if (env.n) {
        properties.push(`n: exportedVars.nFunction(${JSON.stringify(env.n)})`);
    }

    if (env.sig) {
        properties.push(
            `sig: exportedVars.sigFunction(${JSON.stringify(env.sig)})`,
        );
    }

    const code = `${data.output}\nreturn { ${properties.join(", ")} }`;

    return new Function(code)();
};
