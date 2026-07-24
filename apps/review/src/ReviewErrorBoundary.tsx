import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ReviewErrorBoundary extends Component<Props, State> {
	override state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	override componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error("GraphReFly Stack review failed", error, info.componentStack);
	}

	override render() {
		if (this.state.error === null) return this.props.children;
		return (
			<main className="load-state is-error review-crash">
				<strong>Review view could not be rendered.</strong>
				<span>{this.state.error.message}</span>
				<button type="button" onClick={() => window.location.reload()}>
					Reload review
				</button>
			</main>
		);
	}
}
