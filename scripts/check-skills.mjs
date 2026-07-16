import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const skillsRoot = resolve(root, ".agents/skills");
const failures = [];
const skillNames = readdirSync(skillsRoot, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.sort();

for (const folderName of skillNames) {
	const skillRoot = resolve(skillsRoot, folderName);
	const skillPath = resolve(skillRoot, "SKILL.md");
	const metadataPath = resolve(skillRoot, "agents/openai.yaml");
	if (!/^[a-z0-9-]{1,64}$/u.test(folderName)) failures.push(`${folderName}: invalid folder name`);
	if (!existsSync(skillPath) || !existsSync(metadataPath)) {
		failures.push(`${folderName}: SKILL.md and agents/openai.yaml are required`);
		continue;
	}

	const skill = readFileSync(skillPath, "utf8");
	const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/u)?.[1];
	if (!frontmatter) {
		failures.push(`${folderName}: missing YAML frontmatter`);
		continue;
	}
	const fields = new Map(
		frontmatter.split("\n").map((line) => {
			const separator = line.indexOf(":");
			return [line.slice(0, separator), line.slice(separator + 1).trim()];
		}),
	);
	if (fields.size !== 2 || !fields.has("name") || !fields.has("description")) {
		failures.push(`${folderName}: frontmatter must contain only name and description`);
	}
	if (fields.get("name") !== folderName) failures.push(`${folderName}: name must match folder`);
	if (!fields.get("description")) failures.push(`${folderName}: description must not be empty`);
	if (/\bTODO\b|\[TODO/iu.test(skill)) failures.push(`${folderName}: unresolved TODO placeholder`);

	const metadata = readFileSync(metadataPath, "utf8");
	const shortDescription = metadata.match(/short_description:\s*"([^"]+)"/u)?.[1];
	if (!shortDescription || shortDescription.length < 25 || shortDescription.length > 64) {
		failures.push(`${folderName}: short_description must contain 25-64 characters`);
	}
	if (!metadata.includes(`$${folderName}`)) {
		failures.push(`${folderName}: default_prompt must explicitly mention $${folderName}`);
	}
	for (const forbidden of [
		"README.md",
		"INSTALLATION_GUIDE.md",
		"QUICK_REFERENCE.md",
		"CHANGELOG.md",
	]) {
		if (existsSync(resolve(skillRoot, forbidden)))
			failures.push(`${folderName}: remove ${forbidden}`);
	}
}

if (failures.length > 0) {
	console.error(failures.map((failure) => `- ${failure}`).join("\n"));
	process.exitCode = 1;
} else {
	console.log(`Project skills valid: ${skillNames.length}`);
}
