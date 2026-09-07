import assert from "node:assert/strict";
import * as consumer from "../src/refresh-session.ts";

// Expected HTTP behavior is authored independently of Stack's binding result.
export function verifyBusiness() {
	const cases = [
		{
			name: "valid refresh",
			input: { token: "valid", tenant: "acme", active: true, age: 1 },
			status: 200,
		},
		{
			name: "missing token",
			input: { token: "", tenant: "acme", active: true, age: 1 },
			status: 400,
		},
		{
			name: "invalid token",
			input: { token: "forged", tenant: "acme", active: true, age: 1 },
			status: 401,
		},
		{
			name: "disabled tenant",
			input: { token: "valid", tenant: "other", active: true, age: 1 },
			status: 403,
		},
		{
			name: "inactive session",
			input: { token: "valid", tenant: "acme", active: false, age: 1 },
			status: 403,
		},
		{
			name: "age boundary",
			input: { token: "valid", tenant: "acme", active: true, age: 30 },
			status: 200,
		},
		{
			name: "expired session",
			input: { token: "valid", tenant: "acme", active: true, age: 31 },
			status: 403,
		},
	];
	const releases = [
		consumer.BuildHttpRefreshOutcome,
		consumer.EmitSecurityAudit,
		consumer.UpdateSessionMetrics,
		consumer.IndependentPasswordResetFlow,
	].map((node) => node.subscribe(() => {}));
	try {
		for (const c of cases) {
			consumer.RequestInput.set(c.input);
			assert.deepEqual(
				consumer.BuildHttpRefreshOutcome.cache,
				{ status: c.status, rotated: c.status === 200 },
				c.name,
			);
			assert.equal(consumer.EmitSecurityAudit.cache.status, c.status, c.name);
			assert.deepEqual(
				consumer.UpdateSessionMetrics.cache,
				{ accepted: c.status === 200 ? 1 : 0, rejected: c.status === 200 ? 0 : 1 },
				c.name,
			);
			assert.deepEqual(consumer.IndependentPasswordResetFlow.cache, { queued: true }, c.name);
		}
		return {
			status: "passed",
			cases: cases.map((c) => c.name),
			oracle: "independent expected HTTP, audit, metrics and password-reset business outputs",
		};
	} finally {
		for (const release of releases) release();
	}
}
