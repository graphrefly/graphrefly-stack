// Runtime schema copies remain source-only so historical emitted package bytes stay immutable.
export const explanationSchema = JSON.parse(
	String.raw`
	{
		"$schema": "http://json-schema.org/draft-07/schema#",
		"$id": "urn:graphrefly-stack:schema:grounded-explanation:v1",
		"type": "object",
		"additionalProperties": false,
		"required": ["schema", "id", "projectionId", "manifestId", "subject", "claims"],
		"properties": {
			"schema": { "const": "graphrefly.stack.grounded-explanation.v1" },
			"id": { "$ref": "#/definitions/Digest" },
			"projectionId": { "$ref": "#/definitions/Digest" },
			"manifestId": { "$ref": "#/definitions/Digest" },
			"subject": { "$ref": "#/definitions/Subject" },
			"claims": {
				"type": "array",
				"minItems": 1,
				"maxItems": 512,
				"uniqueItems": true,
				"items": { "$ref": "#/definitions/Claim" }
			}
		},
		"definitions": {
			"Digest": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
			"Oid": { "type": "string", "pattern": "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" },
			"Label": {
				"type": "string",
				"minLength": 1,
				"maxLength": 2000,
				"pattern": "^[^\\x00-\\x1f]+$"
			},
			"Subject": {
				"type": "object",
				"additionalProperties": false,
				"required": ["repository", "base", "head"],
				"properties": {
					"repository": { "$ref": "#/definitions/Label" },
					"base": { "$ref": "#/definitions/Oid" },
					"head": { "$ref": "#/definitions/Oid" }
				}
			},
			"Ref": {
				"type": "object",
				"additionalProperties": false,
				"required": ["manifestId", "authorityRef", "authorityDigest", "owner", "kind"],
				"properties": {
					"manifestId": { "$ref": "#/definitions/Digest" },
					"authorityRef": { "$ref": "#/definitions/Label" },
					"authorityDigest": { "$ref": "#/definitions/Digest" },
					"owner": { "$ref": "#/definitions/Label" },
					"kind": { "enum": ["decision", "policy", "test", "verifier", "artifact"] }
				}
			},
			"Claim": {
				"type": "object",
				"additionalProperties": false,
				"required": [
					"id",
					"classification",
					"kind",
					"subject",
					"statement",
					"refs",
					"inferenceRule",
					"gap"
				],
				"properties": {
					"id": { "$ref": "#/definitions/Digest" },
					"classification": { "enum": ["supported", "inferred", "unknown"] },
					"kind": {
						"enum": ["direct", "verified-unchanged", "structural-reachability", "evidence-gap"]
					},
					"subject": { "$ref": "#/definitions/Label" },
					"statement": { "$ref": "#/definitions/Label" },
					"refs": {
						"type": "array",
						"minItems": 1,
						"maxItems": 64,
						"uniqueItems": true,
						"items": { "$ref": "#/definitions/Ref" }
					},
					"inferenceRule": { "oneOf": [{ "type": "null" }, { "$ref": "#/definitions/Label" }] },
					"gap": { "oneOf": [{ "type": "null" }, { "$ref": "#/definitions/Label" }] }
				}
			}
		}
	}
	`,
);

export const proposalSchema = JSON.parse(
	String.raw`
	{
		"$schema": "http://json-schema.org/draft-07/schema#",
		"$id": "urn:graphrefly-stack:schema:grounded-handoff-proposal:v1",
		"type": "object",
		"additionalProperties": false,
		"required": [
			"schema",
			"id",
			"explanationId",
			"owner",
			"target",
			"scope",
			"requestedAction",
			"evidenceRefs",
			"nonAuthority"
		],
		"properties": {
			"schema": { "const": "graphrefly.stack.grounded-handoff-proposal.v1" },
			"id": { "$ref": "#/definitions/Digest" },
			"explanationId": { "$ref": "#/definitions/Digest" },
			"owner": { "$ref": "#/definitions/Label" },
			"target": {
				"type": "object",
				"additionalProperties": false,
				"required": ["subject", "projectionId"],
				"properties": {
					"subject": { "$ref": "#/definitions/Subject" },
					"projectionId": { "$ref": "#/definitions/Digest" }
				}
			},
			"scope": {
				"type": "array",
				"minItems": 1,
				"maxItems": 64,
				"uniqueItems": true,
				"items": { "$ref": "#/definitions/Digest" }
			},
			"requestedAction": { "$ref": "#/definitions/Label" },
			"evidenceRefs": {
				"type": "array",
				"minItems": 1,
				"maxItems": 64,
				"uniqueItems": true,
				"items": { "$ref": "#/definitions/Ref" }
			},
			"nonAuthority": {
				"type": "object",
				"additionalProperties": false,
				"required": [
					"executesCapability",
					"mutatesRepository",
					"mutatesReadiness",
					"mutatesHumanReview",
					"mutatesOwnerAdmission",
					"mutatesRuntime",
					"mutatesWorkflow"
				],
				"properties": {
					"executesCapability": { "const": false },
					"mutatesRepository": { "const": false },
					"mutatesReadiness": { "const": false },
					"mutatesHumanReview": { "const": false },
					"mutatesOwnerAdmission": { "const": false },
					"mutatesRuntime": { "const": false },
					"mutatesWorkflow": { "const": false }
				}
			}
		},
		"definitions": {
			"Digest": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
			"Oid": { "type": "string", "pattern": "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" },
			"Label": {
				"type": "string",
				"minLength": 1,
				"maxLength": 2000,
				"pattern": "^[^\\x00-\\x1f]+$"
			},
			"Subject": {
				"type": "object",
				"additionalProperties": false,
				"required": ["repository", "base", "head"],
				"properties": {
					"repository": { "$ref": "#/definitions/Label" },
					"base": { "$ref": "#/definitions/Oid" },
					"head": { "$ref": "#/definitions/Oid" }
				}
			},
			"Ref": {
				"type": "object",
				"additionalProperties": false,
				"required": ["manifestId", "authorityRef", "authorityDigest", "owner", "kind"],
				"properties": {
					"manifestId": { "$ref": "#/definitions/Digest" },
					"authorityRef": { "$ref": "#/definitions/Label" },
					"authorityDigest": { "$ref": "#/definitions/Digest" },
					"owner": { "$ref": "#/definitions/Label" },
					"kind": { "enum": ["decision", "policy", "test", "verifier", "artifact"] }
				}
			}
		}
	}
	`,
);

export const ownerResultSchema = JSON.parse(
	String.raw`
	{
		"$schema": "http://json-schema.org/draft-07/schema#",
		"$id": "urn:graphrefly-stack:schema:grounded-handoff-owner-result:v1",
		"type": "object",
		"additionalProperties": false,
		"required": [
			"schema",
			"id",
			"owner",
			"proposalId",
			"target",
			"status",
			"evidenceRefs",
			"statement"
		],
		"properties": {
			"schema": { "const": "refresh-session.owner-handoff-result.v1" },
			"id": { "$ref": "#/definitions/Digest" },
			"owner": { "$ref": "#/definitions/Label" },
			"proposalId": { "$ref": "#/definitions/Digest" },
			"target": {
				"type": "object",
				"additionalProperties": false,
				"required": ["subject", "projectionId"],
				"properties": {
					"subject": { "$ref": "#/definitions/Subject" },
					"projectionId": { "$ref": "#/definitions/Digest" }
				}
			},
			"status": { "enum": ["admitted", "rejected"] },
			"evidenceRefs": {
				"type": "array",
				"minItems": 1,
				"maxItems": 64,
				"uniqueItems": true,
				"items": { "$ref": "#/definitions/Ref" }
			},
			"statement": { "$ref": "#/definitions/Label" }
		},
		"definitions": {
			"Digest": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
			"Oid": { "type": "string", "pattern": "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" },
			"Label": {
				"type": "string",
				"minLength": 1,
				"maxLength": 2000,
				"pattern": "^[^\\x00-\\x1f]+$"
			},
			"Subject": {
				"type": "object",
				"additionalProperties": false,
				"required": ["repository", "base", "head"],
				"properties": {
					"repository": { "$ref": "#/definitions/Label" },
					"base": { "$ref": "#/definitions/Oid" },
					"head": { "$ref": "#/definitions/Oid" }
				}
			},
			"Ref": {
				"type": "object",
				"additionalProperties": false,
				"required": ["manifestId", "authorityRef", "authorityDigest", "owner", "kind"],
				"properties": {
					"manifestId": { "$ref": "#/definitions/Digest" },
					"authorityRef": { "$ref": "#/definitions/Label" },
					"authorityDigest": { "$ref": "#/definitions/Digest" },
					"owner": { "$ref": "#/definitions/Label" },
					"kind": { "enum": ["decision", "policy", "test", "verifier", "artifact"] }
				}
			}
		}
	}
	`,
);

export const proofSchema = JSON.parse(
	String.raw`
	{
		"$schema": "http://json-schema.org/draft-07/schema#",
		"$id": "urn:graphrefly-stack:schema:grounded-handoff-proof:v1",
		"type": "object",
		"additionalProperties": false,
		"required": [
			"artifact_ref",
			"schema",
			"revision",
			"id",
			"consequenceReview",
			"explanations",
			"proposal",
			"ownerEvidence",
			"reviewProjections",
			"ownerResultControls",
			"compression",
			"attempt",
			"adapter",
			"llmRequired",
			"limitations"
		],
		"properties": {
			"artifact_ref": { "const": "graphrefly-stack:grounded-handoff-proof" },
			"schema": { "const": "graphrefly-stack/grounded-handoff-proof/v1" },
			"revision": { "const": "stack-handoff-v1" },
			"id": { "$ref": "#/definitions/Digest" },
			"consequenceReview": { "type": "object" },
			"explanations": {
				"type": "array",
				"minItems": 2,
				"maxItems": 2,
				"items": { "type": "object" }
			},
			"proposal": { "type": "object" },
			"ownerEvidence": {
				"type": "object",
				"additionalProperties": false,
				"required": ["result", "coordinate"],
				"properties": {
					"result": { "type": "object" },
					"coordinate": {
						"type": "object",
						"additionalProperties": false,
						"required": ["repository", "ref", "commit", "path", "blob", "bytesDigest"],
						"properties": {
							"repository": { "$ref": "#/definitions/Label" },
							"ref": { "$ref": "#/definitions/Label" },
							"commit": { "$ref": "#/definitions/Oid" },
							"path": { "$ref": "#/definitions/Label" },
							"blob": { "$ref": "#/definitions/Oid" },
							"bytesDigest": { "$ref": "#/definitions/Digest" }
						}
					}
				}
			},
			"reviewProjections": {
				"type": "array",
				"minItems": 2,
				"maxItems": 2,
				"items": { "type": "object" }
			},
			"ownerResultControls": {
				"type": "array",
				"minItems": 10,
				"maxItems": 10,
				"uniqueItems": true,
				"items": {
					"type": "object",
					"additionalProperties": false,
					"required": ["case", "inputs", "projection"],
					"properties": {
						"case": {
							"enum": [
								"cross-revision",
								"duplicate",
								"malformed",
								"missing",
								"rehashed-tamper",
								"stale",
								"wrong-evidence",
								"wrong-owner",
								"wrong-proposal",
								"wrong-target"
							]
						},
						"inputs": {
							"type": "array",
							"maxItems": 2,
							"items": {
								"type": "object",
								"additionalProperties": false,
								"required": ["current", "value"],
								"properties": {
									"current": { "type": "boolean" },
									"value": { "type": "object" }
								}
							}
						},
						"projection": { "type": "object" }
					}
				}
			},
			"compression": {
				"type": "object",
				"additionalProperties": false,
				"required": ["reviewed", "available", "unit"],
				"properties": {
					"reviewed": { "type": "integer", "minimum": 1 },
					"available": { "type": "integer", "minimum": 1 },
					"unit": { "$ref": "#/definitions/Label" }
				}
			},
			"attempt": {
				"type": "object",
				"additionalProperties": false,
				"required": ["schema", "id", "baselineRevision", "consequenceProofId", "ownerEvidenceCommit"],
				"properties": {
					"schema": { "const": "graphrefly.stack.grounded-handoff-attempt.v1" },
					"id": { "$ref": "#/definitions/Digest" },
					"baselineRevision": { "$ref": "#/definitions/Oid" },
					"consequenceProofId": { "$ref": "#/definitions/Digest" },
					"ownerEvidenceCommit": { "$ref": "#/definitions/Oid" }
				}
			},
			"adapter": {
				"type": "object",
				"additionalProperties": false,
				"required": ["tool", "version", "sourceDigest"],
				"properties": {
					"tool": { "$ref": "#/definitions/Label" },
					"version": { "$ref": "#/definitions/Label" },
					"sourceDigest": { "$ref": "#/definitions/Digest" }
				}
			},
			"llmRequired": { "const": false },
			"limitations": {
				"type": "array",
				"minItems": 1,
				"maxItems": 32,
				"uniqueItems": true,
				"items": { "$ref": "#/definitions/Label" }
			}
		},
		"definitions": {
			"Digest": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
			"Oid": { "type": "string", "pattern": "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" },
			"Label": { "type": "string", "minLength": 1, "maxLength": 2000, "pattern": "^[^\\x00-\\x1f]+$" }
		}
	}
	`,
);
