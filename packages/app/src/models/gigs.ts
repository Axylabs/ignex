import { defineCollection, type InferDoc, s } from "@ignex/ninox";

export const gigSchema = s.object(
  {
    _id: s.objectId(),
    name: s.string(),
    createdAt: s.date().optional(),
    updatedAt: s.date().optional(),
  },
  { name: "gigs" },
);
export type Gig = InferDoc<typeof gigSchema>;

export const gigs = defineCollection("gigs", gigSchema, {
  timestamps: true,
  // indexes: [{ key: { createdAt: -1 } }],
});
