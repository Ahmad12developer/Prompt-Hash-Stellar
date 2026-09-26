/**
 * Invitation routes — abuse-resistant collaboration workflow (#835).
 */

import express from "express";
import {
  CreateInvitation,
  AcceptInvitation,
  RevokeInvitation,
  ListInvitations,
} from "../controllers/invitationControllers";

export const invitationRouter = express.Router();

// Create invitation
invitationRouter.post("/", CreateInvitation);

// Accept invitation
invitationRouter.post("/:invitationId/accept", AcceptInvitation);

// Revoke invitation
invitationRouter.post("/:invitationId/revoke", RevokeInvitation);

// List invitations for a wallet
invitationRouter.get("/:walletAddress", ListInvitations);
