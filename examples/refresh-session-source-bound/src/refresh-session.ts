import { graph } from "@graphrefly/ts";

export type Request = { token: string; tenant: string; active: boolean; age: number };
export const RefreshSession = graph({ name: "RefreshSession" });
export const RequestInput = RefreshSession.state<Request>(
	{ token: "valid", tenant: "acme", active: true, age: 1 },
	{ name: "RequestInput" },
);
export const ParseRefreshRequest = RefreshSession.derived(
	[RequestInput],
	(request) => ({ ...request, malformed: !request.token || !request.tenant }),
	{ name: "ParseRefreshRequest" },
);
export const LoadTenantPolicy = RefreshSession.derived(
	[ParseRefreshRequest],
	(request) => ({ enabled: request.tenant === "acme", maxAge: 30 }),
	{ name: "LoadTenantPolicy" },
);
export const ValidateTokenContract = RefreshSession.derived(
	[ParseRefreshRequest],
	(request) => !request.malformed && request.token === "valid",
	{ name: "ValidateTokenContract" },
);
export const ResolveSession = RefreshSession.derived(
	[ParseRefreshRequest, ValidateTokenContract],
	(request, valid) => ({ found: valid, active: request.active, age: request.age }),
	{ name: "ResolveSession" },
);
export const EvaluateSessionPolicy = RefreshSession.derived(
	[ResolveSession, LoadTenantPolicy],
	(session, policy) =>
		session.found && session.active && policy.enabled && session.age <= policy.maxAge,
	{ name: "EvaluateSessionPolicy" },
);
export const AdmitRefresh = RefreshSession.derived(
	[ValidateTokenContract, EvaluateSessionPolicy],
	(valid, allowed) => valid && allowed,
	{ name: "AdmitRefresh" },
);
export const BuildHttpRefreshOutcome = RefreshSession.derived(
	[ParseRefreshRequest, ValidateTokenContract, AdmitRefresh],
	(request, valid, admitted) => ({
		status: request.malformed ? 400 : !valid ? 401 : admitted ? 200 : 403,
		rotated: admitted,
	}),
	{ name: "BuildHttpRefreshOutcome" },
);
export const EmitSecurityAudit = RefreshSession.derived(
	[ValidateTokenContract, EvaluateSessionPolicy, BuildHttpRefreshOutcome],
	(valid, allowed, outcome) => ({ event: "refresh", valid, allowed, status: outcome.status }),
	{ name: "EmitSecurityAudit" },
);
export const UpdateSessionMetrics = RefreshSession.derived(
	[AdmitRefresh],
	(admitted) => ({ accepted: admitted ? 1 : 0, rejected: admitted ? 0 : 1 }),
	{ name: "UpdateSessionMetrics" },
);
export const PasswordResetInput = RefreshSession.state("reset@example.invalid", {
	name: "PasswordResetInput",
});
export const IndependentPasswordResetFlow = RefreshSession.derived(
	[PasswordResetInput],
	(email) => ({ queued: email.includes("@") }),
	{ name: "IndependentPasswordResetFlow" },
);
