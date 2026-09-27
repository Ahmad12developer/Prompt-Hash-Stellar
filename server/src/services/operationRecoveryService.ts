import {
  OperationCheckpoint,
  IOperationCheckpoint,
  OperationType,
  OperationStepState,
} from "../models/OperationCheckpoint";

export interface InitiateOperationParams {
  operationType: OperationType;
  userId: string;
  idempotencyKey: string;
  initialStep: string;
  payload?: Record<string, unknown>;
  maxRetries?: number;
}

export interface RecoveryPlan {
  operationId: string;
  canResume: boolean;
  resumeStep: string;
  recommendedAction: "RETRY" | "ROLLBACK" | "MANUAL_REVIEW";
  instructions: string;
}

export class OperationRecoveryService {
  /**
   * Initializes or fetches an existing idempotent operation.
   */
  static async initiateOperation(
    params: InitiateOperationParams
  ): Promise<{ checkpoint: IOperationCheckpoint; isNew: boolean }> {
    const existing = await OperationCheckpoint.findOne({
      idempotencyKey: params.idempotencyKey,
    });

    if (existing) {
      return { checkpoint: existing, isNew: false };
    }

    const operationId = `op_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    const checkpoint = await OperationCheckpoint.create({
      operationId,
      operationType: params.operationType,
      userId: params.userId,
      idempotencyKey: params.idempotencyKey,
      currentStep: params.initialStep,
      overallState: "INITIALIZED",
      steps: [
        {
          stepName: params.initialStep,
          state: "INITIALIZED",
          timestamp: new Date(),
          data: params.payload,
        },
      ],
      payload: params.payload || {},
      maxRetries: params.maxRetries ?? 3,
      nextRecoveryAction: `PROCEED_${params.initialStep.toUpperCase()}`,
    });

    return { checkpoint, isNew: true };
  }

  /**
   * Records execution of a step checkpoint.
   */
  static async recordStep(
    operationId: string,
    stepName: string,
    state: OperationStepState,
    options?: {
      txHash?: string;
      error?: string;
      data?: Record<string, unknown>;
    }
  ): Promise<IOperationCheckpoint> {
    const checkpoint = await OperationCheckpoint.findOne({ operationId });
    if (!checkpoint) {
      throw new Error(`Operation checkpoint not found: ${operationId}`);
    }

    checkpoint.currentStep = stepName;
    checkpoint.overallState = state;
    if (options?.error) {
      checkpoint.lastError = options.error;
    }

    checkpoint.steps.push({
      stepName,
      state,
      timestamp: new Date(),
      txHash: options?.txHash,
      error: options?.error,
      data: options?.data,
    });

    if (state === "CONFIRMED") {
      checkpoint.nextRecoveryAction = "COMPLETED";
    } else if (state === "FAILED" || state === "RECOVERABLE") {
      checkpoint.nextRecoveryAction = `RETRY_${stepName.toUpperCase()}`;
    }

    await checkpoint.save();
    return checkpoint;
  }

  /**
   * Evaluates an interrupted operation and produces a deterministic recovery plan.
   */
  static async evaluateRecovery(operationId: string): Promise<RecoveryPlan> {
    const checkpoint = await OperationCheckpoint.findOne({ operationId });
    if (!checkpoint) {
      throw new Error(`Operation not found: ${operationId}`);
    }

    const hasOnchainSubmission = checkpoint.steps.some(
      (s) => s.state === "ONCHAIN_SUBMITTED" || !!s.txHash
    );

    if (checkpoint.overallState === "CONFIRMED") {
      return {
        operationId,
        canResume: false,
        resumeStep: checkpoint.currentStep,
        recommendedAction: "MANUAL_REVIEW",
        instructions: "Operation has already been confirmed.",
      };
    }

    if (checkpoint.retryCount >= checkpoint.maxRetries) {
      return {
        operationId,
        canResume: false,
        resumeStep: checkpoint.currentStep,
        recommendedAction: "MANUAL_REVIEW",
        instructions: "Max retry limit reached. Maintainer diagnostic review required.",
      };
    }

    if (hasOnchainSubmission) {
      const onchainStep = checkpoint.steps.find((s) => s.state === "ONCHAIN_SUBMITTED");
      return {
        operationId,
        canResume: true,
        resumeStep: "VERIFY_ONCHAIN_STATUS",
        recommendedAction: "RETRY",
        instructions: `Transaction was broadcasted with txHash: ${onchainStep?.txHash || "unknown"}. Verify status on-chain before retrying side effects.`,
      };
    }

    return {
      operationId,
      canResume: true,
      resumeStep: checkpoint.currentStep,
      recommendedAction: "RETRY",
      instructions: `Safe to re-execute step ${checkpoint.currentStep}; no external on-chain side effects were recorded.`,
    };
  }

  /**
   * Resumes an interrupted operation safely.
   */
  static async resumeOperation(operationId: string): Promise<IOperationCheckpoint> {
    const checkpoint = await OperationCheckpoint.findOne({ operationId });
    if (!checkpoint) {
      throw new Error(`Operation not found: ${operationId}`);
    }

    const plan = await this.evaluateRecovery(operationId);
    if (!plan.canResume) {
      throw new Error(`Cannot resume operation: ${plan.instructions}`);
    }

    checkpoint.retryCount += 1;
    checkpoint.overallState = "RECOVERABLE";
    checkpoint.nextRecoveryAction = `RESUMING_${plan.resumeStep}`;
    checkpoint.steps.push({
      stepName: `RESUME_ATTEMPT_${checkpoint.retryCount}`,
      state: "RECOVERABLE",
      timestamp: new Date(),
      data: { plan },
    });

    await checkpoint.save();
    return checkpoint;
  }

  /**
   * Diagnostic query to find stuck operations (older than threshold with unfinalized state).
   */
  static async findStuckOperations(olderThanMinutes: number = 30): Promise<IOperationCheckpoint[]> {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
    return OperationCheckpoint.find({
      overallState: { $in: ["INITIALIZED", "PREVALIDATED", "ONCHAIN_SUBMITTED", "RECOVERABLE"] },
      updatedAt: { $lt: cutoff },
    }).sort({ updatedAt: 1 });
  }

  /**
   * Maintainer action to forcefully resolve or abandon an abandoned operation.
   */
  static async forceResolveOperation(
    operationId: string,
    action: "MARK_CONFIRMED" | "ABANDON" | "FORCE_RETRY",
    maintainerId: string,
    reason: string
  ): Promise<IOperationCheckpoint> {
    const checkpoint = await OperationCheckpoint.findOne({ operationId });
    if (!checkpoint) {
      throw new Error(`Operation not found: ${operationId}`);
    }

    const stateMap: Record<string, OperationStepState> = {
      MARK_CONFIRMED: "CONFIRMED",
      ABANDON: "ABANDONED",
      FORCE_RETRY: "RECOVERABLE",
    };

    checkpoint.overallState = stateMap[action];
    checkpoint.steps.push({
      stepName: `MAINTAINER_${action}`,
      state: stateMap[action],
      timestamp: new Date(),
      data: { maintainerId, reason, priorStep: checkpoint.currentStep },
    });

    await checkpoint.save();
    return checkpoint;
  }
}
