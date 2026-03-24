import { readFileSync } from "node:fs";
import process from "node:process";

const releaseTag = process.env.RELEASE_TAG ?? process.argv[2] ?? "";

if (!releaseTag) {
	console.error("Missing release tag. Pass it as RELEASE_TAG or the first CLI argument.");
	process.exit(1);
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));

const errors = [];

if (packageJson.version !== releaseTag) {
	errors.push(`package.json version ${packageJson.version} does not match release tag ${releaseTag}.`);
}

if (manifest.version !== releaseTag) {
	errors.push(`manifest.json version ${manifest.version} does not match release tag ${releaseTag}.`);
}

if (versions[releaseTag] !== manifest.minAppVersion) {
	errors.push(
		`versions.json[${releaseTag}] must equal manifest minAppVersion ${manifest.minAppVersion}, got ${versions[releaseTag] ?? "undefined"}.`,
	);
}

if (errors.length > 0) {
	for (const error of errors) {
		console.error(error);
	}
	process.exit(1);
}

console.log(`Release metadata verified for ${releaseTag}.`);
