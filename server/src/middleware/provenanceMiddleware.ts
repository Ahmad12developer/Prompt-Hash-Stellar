import { Request, Response, NextFunction } from "express";
import { provenanceService } from "../services/provenanceService";
import { ImportSourceType } from "../models/ProvenanceRecord";
import { logger } from "../services/structuredLogger";

/**
 * Provenance tracking middleware for prompt creation/import endpoints (Issue #929).
 *
 * This middleware automatically creates provenance records when prompts are
 * created or imported through various channels.
 */

/**
 * Extract actor metadata from request.
 */
function extractActorMetadata(req: Request): {
  actorType: "user" | "system" | "service" | "admin";
  actorId: string;
  actorName?: string;
  actorWallet?: string;
  actorEmail?: string;
  actorRole?: string;
  actorIp?: string;
  actorUserAgent?: string;
} {
  const user = (req as any).user;
  const wallet = (req as any).walletAddress || user?.walletAddress;
  
  return {
    actorType: user?.role === "admin" ? "admin" : user ? "user" : "system",
    actorId: wallet || user?._id?.toString() || "system",
    actorName: user?.username || user?.displayName,
    actorWallet: wallet,
    actorEmail: user?.email,
    actorRole: user?.role,
    actorIp: req.ip || req.headers["x-forwarded-for"]?.toString() || req.socket.remoteAddress,
    actorUserAgent: req.headers["user-agent"],
  };
}

/**
 * Middleware: Track provenance for API-created prompts.
 */
export function trackApiCreation() {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Store original send to intercept response
    const originalSend = res.send.bind(res);
    
    res.send = function (data: any) {
      // Only track successful prompt creation (2xx status)
      if (res.statusCode >= 200 && res.statusCode < 300) {
        // Parse response to get prompt ID
        try {
          const responseData = typeof data === "string" ? JSON.parse(data) : data;
          const promptId = responseData?._id || responseData?.promptId || responseData?.id;
          
          if (promptId) {
            // Create provenance record asynchronously (don't block response)
            provenanceService
              .createProvenanceRecord({
                promptId,
                onChainId: responseData?.onChainId,
                sourceType: "api" as ImportSourceType,
                sourceSystem: {
                  systemName: "PromptHash API",
                  systemVersion: process.env.API_VERSION || "1.0.0",
                  apiEndpoint: `${req.method} ${req.path}`,
                  apiVersion: req.headers["api-version"]?.toString() || "v1",
                },
                actor: extractActorMetadata(req),
                metadata: {
                  endpoint: req.path,
                  method: req.method,
                  requestId: (res as any).locals?.requestId,
                },
              })
              .catch((error) => {
                logger.error("Failed to create provenance record for API creation", {
                  error,
                  promptId,
                  endpoint: req.path,
                });
              });
          }
        } catch (error) {
          logger.error("Failed to parse response for provenance tracking", { error });
        }
      }
      
      return originalSend(data);
    };
    
    next();
  };
}

/**
 * Middleware: Track provenance for manually created prompts.
 */
export function trackManualCreation() {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Attach provenance tracking to response locals
    res.locals.provenanceTracker = {
      sourceType: "manual" as ImportSourceType,
      actor: extractActorMetadata(req),
    };
    
    next();
  };
}

/**
 * Middleware: Track provenance for imported prompts from files.
 */
export function trackFileImport(batchInfo?: {
  batchId: string;
  batchName?: string;
}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    res.locals.provenanceTracker = {
      sourceType: "file_upload" as ImportSourceType,
      importBatch: batchInfo,
      actor: extractActorMetadata(req),
    };
    
    next();
  };
}

/**
 * Middleware: Track provenance for prompts imported from external APIs.
 */
export function trackExternalImport(sourceSystem: {
  systemName: string;
  systemUrl?: string;
  apiEndpoint?: string;
}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    res.locals.provenanceTracker = {
      sourceType: "external_api" as ImportSourceType,
      sourceSystem: {
        ...sourceSystem,
        systemVersion: req.headers["x-source-version"]?.toString(),
        externalId: req.body?.externalId || req.query?.externalId,
        externalUrl: req.body?.externalUrl || req.query?.externalUrl,
      },
      actor: extractActorMetadata(req),
    };
    
    next();
  };
}

/**
 * Middleware: Track provenance for AI-generated prompts.
 */
export function trackAiGeneration(modelInfo?: {
  model: string;
  version: string;
}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    res.locals.provenanceTracker = {
      sourceType: "ai_generated" as ImportSourceType,
      sourceSystem: {
        systemName: "AI Generation Service",
        systemVersion: modelInfo?.version || "1.0.0",
      },
      transformations: [
        {
          transformType: "ai_enhancement" as const,
          transformVersion: modelInfo?.version || "1.0.0",
          transformConfig: modelInfo,
          transformedFields: ["content", "title", "description"],
          transformTimestamp: new Date(),
        },
      ],
      actor: extractActorMetadata(req),
      metadata: {
        model: modelInfo?.model,
        aiGenerated: true,
      },
    };
    
    next();
  };
}

/**
 * Helper function to finalize provenance tracking after prompt creation.
 * Call this from controllers after a prompt is successfully created.
 */
export async function finalizeProvenance(
  res: Response,
  promptId: string,
  additionalData?: {
    onChainId?: string;
    parentProvenanceId?: string;
    sourcePromptId?: string;
    metadata?: Record<string, any>;
  }
): Promise<void> {
  const tracker = res.locals.provenanceTracker;
  
  if (!tracker) {
    // No provenance tracking configured for this request
    return;
  }
  
  try {
    await provenanceService.createProvenanceRecord({
      promptId,
      onChainId: additionalData?.onChainId,
      sourceType: tracker.sourceType,
      sourceSystem: tracker.sourceSystem || {
        systemName: "PromptHash Platform",
        systemVersion: process.env.API_VERSION || "1.0.0",
      },
      importBatch: tracker.importBatch,
      transformations: tracker.transformations,
      actor: tracker.actor,
      parentProvenanceId: additionalData?.parentProvenanceId,
      sourcePromptId: additionalData?.sourcePromptId,
      metadata: {
        ...tracker.metadata,
        ...additionalData?.metadata,
      },
    });
    
    logger.info("Provenance tracking finalized", {
      promptId,
      sourceType: tracker.sourceType,
      actorId: tracker.actor.actorId,
    });
  } catch (error) {
    // Log error but don't fail the request
    logger.error("Failed to finalize provenance tracking", {
      error,
      promptId,
      sourceType: tracker.sourceType,
    });
  }
}

/**
 * Helper function to create provenance for blockchain-indexed prompts.
 * Called from the indexer when processing on-chain events.
 */
export async function trackBlockchainIndexing(params: {
  promptId: string;
  onChainId: string;
  creatorWallet: string;
  ledgerSequence: number;
  transactionHash: string;
  eventType: string;
}): Promise<void> {
  try {
    await provenanceService.createProvenanceRecord({
      promptId: params.promptId,
      onChainId: params.onChainId,
      sourceType: "manual", // On-chain creation is considered manual by creator
      sourceSystem: {
        systemName: "Stellar Blockchain",
        systemVersion: "Soroban",
        systemUrl: process.env.PUBLIC_STELLAR_RPC_URL,
        externalId: params.transactionHash,
        externalUrl: `${process.env.PUBLIC_STELLAR_EXPLORER_URL}/tx/${params.transactionHash}`,
      },
      actor: {
        actorType: "user",
        actorId: params.creatorWallet,
        actorWallet: params.creatorWallet,
      },
      metadata: {
        indexed: true,
        ledgerSequence: params.ledgerSequence,
        transactionHash: params.transactionHash,
        eventType: params.eventType,
        indexedAt: new Date().toISOString(),
      },
    });
    
    logger.info("Blockchain provenance tracked", {
      promptId: params.promptId,
      onChainId: params.onChainId,
      ledger: params.ledgerSequence,
    });
  } catch (error) {
    logger.error("Failed to track blockchain provenance", { error, params });
    throw error;
  }
}
