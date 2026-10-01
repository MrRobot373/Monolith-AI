export interface Admin {
  id: string;
  email: string;
  name: string;
}

export interface CustomerRow {
  id: string;
  name: string;
  contactEmail: string | null;
  createdAt: string;
  licenses: number;
  tier: string | null;
  seats: number | null;
  activeSeats: number | null;
  status: "active" | "revoked" | null;
  expiresAt: string | null;
  lastCheckInAt: string | null;
}

export interface LicenseRow {
  id: string;
  customerId: string;
  tier: string;
  seats: number;
  sections: string[];
  features: string[];
  modelMode: "self" | "managed";
  workspaceLimit: number | null;
  accent: string | null;
  checkInHours: number;
  expiresAt: string;
  status: "active" | "revoked";
  token: string;
  issuedAt: string;
  lastCheckInAt: string | null;
  lastVersion: string | null;
  activeSeats: number | null;
  instanceId: string | null;
  instanceConflict: boolean;
  createdAt: string;
}

export interface CheckInRow {
  id: string;
  licenseId: string;
  instanceId: string;
  version: string | null;
  activeSeats: number;
  usage: { section: string; inputTokens: number; outputTokens: number; requests: number }[];
  createdAt: string;
}

export interface CustomerDetail {
  id: string;
  name: string;
  contactEmail: string | null;
  notes: string | null;
  createdAt: string;
  licenses: LicenseRow[];
  checkIns: CheckInRow[];
}

export interface Overview {
  customers: number;
  activeLicenses: number;
  seatsSold: number;
  seatsUsed: number;
  expiringSoon: number;
  silent: number;
  tokensDaily: { date: string; input: number; output: number }[];
  attention: {
    id: string;
    customerId: string;
    customer: string;
    expiresAt: string;
    lastCheckInAt: string | null;
    instanceConflict: boolean;
    seats: number;
    activeSeats: number | null;
  }[];
}
