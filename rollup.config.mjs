import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

const sdPlugin = "dev.gitflowlink.gifdeck.sdPlugin";

/**
 * @type {import('rollup').RollupOptions}
 */
const config = {
	input: "src/plugin.ts",
	output: {
		file: `${sdPlugin}/bin/plugin.js`,
		sourcemap: true,
		sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
			return relativeSourcePath.replace(/^src/, `${sdPlugin}/src`);
		},
	},
	plugins: [
		typescript({
			mapRoot: process.env.NODE_ENV === "watch" ? "./" : undefined,
		}),
		nodeResolve({
			browser: false,
			exportConditions: ["node"],
			preferBuiltins: true,
		}),
		commonjs(),
	],
};

export default config;
