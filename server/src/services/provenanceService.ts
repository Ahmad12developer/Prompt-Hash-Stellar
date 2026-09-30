import ProvenanceRecord, {
  ImportSourceType,
  TransformType,
  IImportBatch,
  ISourceSystem,
  ITransformMetadata,
  IActorMetadata,
} from "../models/ProvenanceRecord";
import Prompt from "../models/Prompt";
import { logger } from "./structuredLogger";
import { recordAuditEvent } from "./auditTrail";

/**
 * Provenance Service - manages provenance tracking for prompts (Issue #929).
 *
 * This service provides functions to:
 * - Create provenance records for imported/created prompts
 * - Track transformations applied to prompts
 * - Query provenance lineage
 * - Export provenance data for audit/compliance
 */

export interface CreateProvenanceParams {
  promptId: string;
  onChainId?: string;
  sourceType: ImportSourceType;
  sourceSystem: ISourceSystem;
  importBatch?: Partial<IImportBatch>;
  transformations?: Partial<ITransformMetadata>[];
  actor: IActorMetadata;
  parentProvenanceId?: string;
  sourcePromptId?: string;
  metadata?: Record<string, any>;
}

export interface UpdateTransformationParams {
  provenanceId: string;
  transformation: ITransformMetadata;
}

export interface QueryProvenanceParams {
  promptId?: string;
  batchId?: string;
  actorId?: string;
  sourceType?: ImportSourceType;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  includeDeleted?: boolean;
}

export interface ProvenanceExport {
  promptId: string;
  onChainId?: string;
  sourceType: string;
  sourceSystem: ISourceSystem;
  importBatch?: Partial<IImportBatch>;
  transformations: ITransformMetadata[];
  actor: IActorMetadata;
  parentProvenanceId?: string;
  lineageDepth: number;
  createdAt: Date;
  updatedAt: Date;
}

class ProvenanceService {
  /**
   * Create a new provenance record for a prompt.
   */
  async createProvenanceRecord(params: CreateProvenanceParams): Promise<any> {
    try {
      const {
        promptId,
        onChainId,
        sourceType,
        sourceSystem,
        importBatch,
        transformations,
        actor,
        parentProvenanceId,
        sourcePromptId,
        metadata,
      } = params;

      // Validate prompt exists
      const prompt = await Prompt.findById(promptId);
      if (!prompt) {
        throw new Error(`Prompt not found: ${promptId}`);
      }

      // Validate parent provenance if specified
      if (parentProvenanceId) {
        const parentProvenance = await ProvenanceRecord.findById(parentProvenanceId);
        if (!parentProvenance) {
          throw new Error(`Parent provenance record not found: ${parentProvenanceId}`);
        }
      }

      // Create provenance record
      const provenanceRecord = new ProvenanceRecord({
        promptId,
        onChainId,
        sourceType,
        sourceSystem,
        importBatch: importBatch || null,
        transformations: transformations || [],
        actor,
        parentProvenanceId: parentProvenanceId || null,
        sourcePromptId: sourcePromptId || null,
        metadata: metadata || {},
        verificationStatus: "unverified",
      });

      await provenanceRecord.save();

      // Update prompt with provenance reference
      await Prompt.findByIdAndUpdate(promptId, {
        provenanceSource: sourceType,
        provenanceBatchId: importBatch?.batchId || null,
        provenanceActorId: actor.actorId,
        provenanceRecordId: provenanceRecord._id,
        hasProvenance: true,
      });

      // Audit log
      await recordAuditEvent({
        action: "provenance_record_created",
        result: "success",
        actor: actor.actorId,
        target: promptId,
        targetType: "prompt",
        metadata: {
          provenanceId: provenanceRecord._id.toString(),
          sourceType,
          batchId: importBatch?.batchId,
        },
      });

      logger.info("Provenance record created", {
        provenanceId: provenanceRecord._id,
        promptId,
        sourceType,
      });

      return provenanceRecord;
    } catch (error) {
      logger.error("Failed to create provenance record", { error, params });
      throw error;
    }
  }

  /**
   * Add a transformation to an existing provenance record.
   */
  async addTransformation(params: UpdateTransformationParams): Promise<any> {
    try {
      const { provenanceId, transformation } = params;

      const provenanceRecord = await ProvenanceRecord.findById(provenanceId);
      if (!provenanceRecord) {
        throw new Error(`Provenance record not found: ${provenanceId}`);
      }

      // Add transformation
      provenanceRecord.transformations.push(transformation);
      await provenanceRecord.save();

      logger.info("Transformation added to provenance record", {
        provenanceId,
        transformType: transformation.transformType,
      });

      return provenanceRecord;
    } catch (error) {
      logger.error("Failed to add transformation", { error, params });
      throw error;
    }
  }

  /**
   * Get provenance record for a prompt.
   */
  async getProvenanceByPromptId(promptId: string): Promise<any | null> {
    try {
      return await ProvenanceRecord.findOne({
        promptId,
        isDeleted: false,
      }).sort({ createdAt: -1 });
    } catch (error) {
      logger.error("Failed to get provenance by prompt ID", { error, promptId });
      throw error;
    }
  }

  /**
   * Get full lineage for a prompt (all ancestor provenance records).
   */
  async getLineage(promptId: string): Promise<any[]> {
    try {
      const provenance = await this.getProvenanceByPromptId(promptId);
      if (!provenance) {
        return [];
      }

      const lineage = [provenance];
      let current = provenance;

      while (current.parentProvenanceId) {
        const parent = await ProvenanceRecord.findById(current.parentProvenanceId);
        if (!parent) break;
        lineage.unshift(parent);
        current = parent;
      }

      return lineage;
    } catch (error) {
      logger.error("Failed to get lineage", { error, promptId });
      throw error;
    }
  }

  /**
   * Get all derived prompts (descendants) from a prompt.
   */
  async getDerivatives(promptId: string): Promise<any[]> {
    try {
      const provenance = await this.getProvenanceByPromptId(promptId);
      if (!provenance) {
        return [];
      }

      return await provenance.getDescendants();
    } catch (error) {
      logger.error("Failed to get derivatives", { error, promptId });
      throw error;
    }
  }

  /**
   * Query provenance records with filters.
   */
  async queryProvenance(params: QueryProvenanceParams): Promise<any[]> {
    try {
      const {
        promptId,
        batchId,
        actorId,
        sourceType,
        startDate,
        endDate,
        limit = 100,
        includeDeleted = false,
      } = params;

      const query: any = {};

      if (promptId) query.promptId = promptId;
      if (batchId) query["importBatch.batchId"] = batchId;
      if (actorId) query["actor.actorId"] = actorId;
      if (sourceType) query.sourceType = sourceType;
      if (!includeDeleted) query.isDeleted = false;

      if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = startDate;
        if (endDate) query.createdAt.$lte = endDate;
      }

      return await ProvenanceRecord.find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate("promptId", "title onChainId owner")
        .populate("sourcePromptId", "title onChainId");
    } catch (error) {
      logger.error("Failed to query provenance", { error, params });
      throw error;
    }
  }

  /**
   * Get all prompts in an import batch.
   */
  async getBatchPrompts(batchId: string): Promise<any[]> {
    try {
      const provenanceRecords = await ProvenanceRecord.find({
        "importBatch.batchId": batchId,
        isDeleted: false,
      }).populate("promptId");

      return provenanceRecords.map((record) => record.promptId).filter(Boolean);
    } catch (error) {
      logger.error("Failed to get batch prompts", { error, batchId });
      throw error;
    }
  }

  /**
   * Verify provenance record integrity.
   */
  async verifyProvenance(provenanceId: string, verifiedBy: string, notes?: string): Promise<any> {
    try {
      const provenanceRecord = await ProvenanceRecord.findById(provenanceId);
      if (!provenanceRecord) {
        throw new Error(`Provenance record not found: ${provenanceId}`);
      }

      provenanceRecord.verificationStatus = "verified";
      provenanceRecord.verificationTimestamp = new Date();
      provenanceRecord.verificationNotes = notes || "";
      await provenanceRecord.save();

      await recordAuditEvent({
        action: "provenance_verified",
        result: "success",
        actor: verifiedBy,
        target: provenanceId,
        targetType: "provenance_record",
        metadata: { notes },
      });

      logger.info("Provenance verified", { provenanceId, verifiedBy });
      return provenanceRecord;
    } catch (error) {
      logger.error("Failed to verify provenance", { error, provenanceId });
      throw error;
    }
  }

  /**
   * Mark provenance as disputed.
   */
  async disputeProvenance(provenanceId: string, disputedBy: string, reason: string): Promise<any> {
    try {
      const provenanceRecord = await ProvenanceRecord.findById(provenanceId);
      if (!provenanceRecord) {
        throw new Error(`Provenance record not found: ${provenanceId}`);
      }

      provenanceRecord.verificationStatus = "disputed";
      provenanceRecord.verificationTimestamp = new Date();
      provenanceRecord.verificationNotes = reason;
      await provenanceRecord.save();

      await recordAuditEvent({
        action: "provenance_disputed",
        result: "success",
        actor: disputedBy,
        target: provenanceId,
        targetType: "provenance_record",
        metadata: { reason },
      });

      logger.warn("Provenance disputed", { provenanceId, disputedBy, reason });
      return provenanceRecord;
    } catch (error) {
      logger.error("Failed to dispute provenance", { error, provenanceId });
      throw error;
    }
  }

  /**
   * Soft delete a provenance record.
   */
  async deleteProvenance(provenanceId: string, deletedBy: string, reason: string): Promise<any> {
    try {
      const provenanceRecord = await ProvenanceRecord.findById(provenanceId);
      if (!provenanceRecord) {
        throw new Error(`Provenance record not found: ${provenanceId}`);
      }

      provenanceRecord.isDeleted = true;
      provenanceRecord.deletedAt = new Date();
      provenanceRecord.deletedBy = deletedBy;
      provenanceRecord.deletionReason = reason;
      await provenanceRecord.save();

      await recordAuditEvent({
        action: "provenance_deleted",
        result: "success",
        actor: deletedBy,
        target: provenanceId,
        targetType: "provenance_record",
        metadata: { reason },
      });

      logger.info("Provenance deleted", { provenanceId, deletedBy });
      return provenanceRecord;
    } catch (error) {
      logger.error("Failed to delete provenance", { error, provenanceId });
      throw error;
    }
  }

  /**
   * Export provenance data for a prompt or batch.
   */
  async exportProvenance(params: {
    promptId?: string;
    batchId?: string;
    format?: "json" | "csv";
  }): Promise<ProvenanceExport[]> {
    try {
      const { promptId, batchId } = params;

      const query: any = { isDeleted: false };
      if (promptId) query.promptId = promptId;
      if (batchId) query["importBatch.batchId"] = batchId;

      const records = await ProvenanceRecord.find(query)
        .populate("promptId", "title onChainId")
        .sort({ createdAt: 1 });

      const exports: ProvenanceExport[] = [];

      for (const record of records) {
        const lineage = await this.getLineage(record.promptId);
        
        exports.push({
          promptId: record.promptId,
          onChainId: record.onChainId,
          sourceType: record.sourceType,
          sourceSystem: record.sourceSystem,
          importBatch: record.importBatch,
          transformations: record.transformations,
          actor: record.actor,
          parentProvenanceId: record.parentProvenanceId?.toString(),
          lineageDepth: lineage.length,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        });
      }

      return exports;
    } catch (error) {
      logger.error("Failed to export provenance", { error, params });
      throw error;
    }
  }

  /**
   * Get import statistics.
   */
  async getImportStatistics(params: {
    startDate?: Date;
    endDate?: Date;
    sourceType?: ImportSourceType;
    actorId?: string;
  }): Promise<any> {
    try {
      return await ProvenanceRecord.getImportStats(params);
    } catch (error) {
      logger.error("Failed to get import statistics", { error, params });
      throw error;
    }
  }

  /**
   * Handle deleted source prompts - mark provenance as invalid.
   */
  async handleDeletedSource(sourcePromptId: string): Promise<void> {
    try {
      const affectedRecords = await ProvenanceRecord.find({
        sourcePromptId,
        isDeleted: false,
      });

      for (const record of affectedRecords) {
        record.verificationStatus = "invalid";
        record.verificationTimestamp = new Date();
        record.verificationNotes = "Source prompt was deleted";
        await record.save();
      }

      logger.info("Updated provenance for deleted source", {
        sourcePromptId,
        affectedCount: affectedRecords.length,
      });
    } catch (error) {
      logger.error("Failed to handle deleted source", { error, sourcePromptId });
      throw error;
    }
  }
}

export const provenanceService = new ProvenanceService();
