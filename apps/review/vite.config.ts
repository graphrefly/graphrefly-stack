import react from "@vitejs/plugin-react";
import { defineConfig, searchForWorkspaceRoot } from "vite";

export default defineConfig({
	plugins: [react()],
	server: {
		fs: {
			allow: [searchForWorkspaceRoot(process.cwd())],
		},
	},
});
