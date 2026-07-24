import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { ReviewErrorBoundary } from "./ReviewErrorBoundary";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Review root element is missing");

createRoot(root).render(
	<StrictMode>
		<ReviewErrorBoundary>
			<App />
		</ReviewErrorBoundary>
	</StrictMode>,
);
