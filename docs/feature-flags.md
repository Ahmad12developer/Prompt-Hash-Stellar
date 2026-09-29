# Feature Flag Framework & Rollout Runbook

_Issue #813 — Typed Feature Flags, Safe Defaults, Staged Rollout, and Emergency Rollback_

## 1. Overview

The Feature Flag Framework enables safe, staged rollouts of risky marketplace changes (such as Soroban atomic settlements, new sanitize pipelines, and automated reconciliation) with fine-grained environment controls and instant emergency rollback without requiring a code redeploy.

---

## 2. Typed Flag Definitions & Safe Defaults

All system feature flags are typed and registered with fail-safe defaults:

| Flag Key | Purpose | Default Status | Environments | Safe Fallback |
|---|---|---|---|---|
| `stellar_atomic_settlement` | Soroban multi-prompt atomic settlement contract calls | `disabled` | Dev only | `false` (Legacy settlement) |
| `bulk_purchase_atomic_v2` | v2 Atomic multi-prompt cart checkout processor | `disabled` | Dev only | `false` (Single checkout) |
| `prompt_preview_markdown_sanitize_v2` | Enhanced HTML sanitizer stripping dangerous tags/iframes | `enabled` | All | `true` (Strict sanitization) |
| `payout_reconciliation_auto_resolve` | Automated resolution for zero-drift payout statements | `disabled` | Dev only | `false` (Manual admin approval) |
| `operational_health_dashboard` | Real-time maintainer health aggregation dashboard | `enabled` | All | `true` (Dashboard active) |
| `strict_settlement_checks` | On-chain transaction verification before entitlement | `enabled` | All | `true` (Strict verification) |

### Fail-Safe Guarantee
- If a flag is not found in the database, the system immediately returns its preconfigured **`safeFallback`**.
- If the database connection is interrupted or errors occur, `featureFlagService` catches the exception and returns the safe fallback without failing the upstream user request.

---

## 3. Data Model

Flags are stored in the MongoDB `FeatureFlag` collection:

```typescript
{
  name: string;              // Unique identifier (lowercase, e.g. "stellar_atomic_settlement")
  description: string;       // Human-readable purpose
  status: 'enabled' | 'disabled' | 'experimental';
  environments: {
    development?: boolean;
    staging?: boolean;
    production?: boolean;
  };
  rolloutPercentage: number; // 0-100 (for experimental status with consistent hashing)
  createdBy: string;         // Admin identifier
  createdAt: Date;
  updatedAt: Date;
}
```

---

## 4. API Endpoints

### Public / Client Routes
- **`GET /api/flags/definitions`**: List all known typed flag definitions and default fallbacks.
- **`POST /api/flags/check/:name`**: Check if a feature is enabled for a given user / environment context.
  ```json
  {
    "userId": "GD...1234",
    "environment": "production"
  }
  ```
  **Response**:
  ```json
  {
    "name": "stellar_atomic_settlement",
    "enabled": false,
    "reason": "Flag is disabled in environment: production",
    "source": "database"
  }
  ```

### Admin Routes (Requires `flags:write` / `flags:read` scope)
- **`GET /api/flags`**: List all stored flags.
- **`POST /api/flags`**: Create a new feature flag.
- **`PATCH /api/flags/:name`**: Update status, environments, or rollout percentage.
- **`DELETE /api/flags/:name`**: Remove a feature flag.

---

## 5. Usage in Code

### Server-Side Protection
```typescript
import { featureFlagService } from "../services/featureFlagService.js";

// Check before executing sensitive path
const canAutoReconcile = await featureFlagService.isEnabled(
  "payout_reconciliation_auto_resolve",
  process.env.NODE_ENV as any
);

if (canAutoReconcile) {
  await autoReconcilePayouts();
} else {
  logger.info("Auto-reconciliation flag disabled; queuing for manual review.");
}
```

### Client-Side (React Hook)
```tsx
import { useFeatureFlag } from "@/hooks/useFeatureFlag";

export function CheckoutButton({ userWallet }: { userWallet: string }) {
  const { enabled: atomicEnabled, loading } = useFeatureFlag("bulk_purchase_atomic_v2", userWallet);

  if (loading) return <Spinner />;
  return atomicEnabled ? <AtomicBulkCheckout /> : <StandardCheckout />;
}
```

---

## 6. Staged Rollout Workflow

1. **Stage 1: Internal Development Validation**
   - Register flag with status `enabled` on `development` only.
   ```bash
   curl -X POST http://localhost:5000/api/flags \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -d '{"name":"stellar_atomic_settlement","description":"Atomic settlement","status":"enabled","environments":{"development":true,"staging":false,"production":false},"createdBy":"admin"}'
   ```
2. **Stage 2: Staging Integration**
   - Enable on `staging` environment and run automated E2E test suites.
3. **Stage 3: Experimental Canary Rollout in Production**
   - Set status to `experimental` with `rolloutPercentage: 10` on `production`.
   - User wallet addresses are hashed deterministically so individual users experience uniform behavior.
4. **Stage 4: General Availability (100% Rollout)**
   - Update flag to `status: "enabled"` with `production: true`.

---

## 7. Emergency Rollback Procedure (Zero Downtime)

If an anomaly, regression, or invariant failure is detected during rollout:

### Immediate Action (1 Command)
```bash
curl -X PATCH http://localhost:5000/api/flags/stellar_atomic_settlement \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"status":"disabled","environments":{"production":false}}'
```

### Verification
```bash
curl -X POST http://localhost:5000/api/flags/check/stellar_atomic_settlement \
  -H "Content-Type: application/json" \
  -d '{"environment":"production"}'
# Response must be: {"name":"stellar_atomic_settlement","enabled":false,...}
```
All in-flight traffic instantly falls back to the safe, stable execution branch.
