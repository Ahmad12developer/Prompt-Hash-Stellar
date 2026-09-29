import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema(
  {
    recipientWallet: {
      type: String,
      required: true,
      lowercase: true,
      index: true,
    },
    promptId: {
      type: String,
      required: true,
      index: true,
    },
    promptTitle: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      required: true,
      enum: ["prompt_update"],
    },
    message: {
      type: String,
      required: true,
    },
    versionIndex: {
      type: Number,
      required: true,
    },
    changeNote: {
      type: String,
      default: "",
    },
    sourceEventId: {
      type: String,
      required: true,
      index: true,
    },
    dedupeKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    deliveryStatus: {
      type: String,
      enum: ["pending", "delivered", "failed"],
      default: "delivered",
      index: true,
    },
    attempts: {
      type: Number,
      default: 1,
      min: 0,
    },
    lastError: {
      type: String,
      default: "",
    },
    deliveredAt: {
      type: Date,
      default: Date.now,
    },
    read: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { timestamps: true },
);

notificationSchema.index({ recipientWallet: 1, read: 1, createdAt: -1 });
notificationSchema.index({ sourceEventId: 1, recipientWallet: 1 });

const Notification = mongoose.models.Notification || mongoose.model("Notification", notificationSchema);
export default Notification;
