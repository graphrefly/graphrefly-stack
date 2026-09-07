import test from "node:test";
import { verifyBusiness } from "./business-verifier.mjs";

test("RefreshSession business outcomes and independent control", () => {
	verifyBusiness();
});
