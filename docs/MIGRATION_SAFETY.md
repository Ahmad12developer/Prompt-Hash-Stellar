# Migration Safety Framework Guide (Issue #833)

## Overview
The Migration Safety Framework provides dry-run previews, automated post-checks, and rollback procedures for schema and data migrations.

## Workflow

### 1. Dry Run Preview
Simulates transforms over target collections without mutating records:
```bash
node scripts/migration-safety.mjs --dry-run --migration=001_payout_basis_points
```

### 2. Execution & Post-Validation
Applies transformations and asserts that post-validation checks pass on every updated record. If any check fails, errors are recorded and rollback plans are generated.

### 3. Verification
```bash
node scripts/migration-safety.mjs --verify --migration=001_payout_basis_points
```
