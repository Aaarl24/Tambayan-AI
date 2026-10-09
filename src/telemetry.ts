// src/telemetry.ts
// Edge telemetry: turns raw counts into availability and workstation metrics,
// entirely on-device. No network, no images.
import type { Counts } from './detection';

export type Availability = 'none' | 'available' | 'filling' | 'full';
export type OutletDemand = 'low' | 'medium' | 'high';

export interface Telemetry {
  /** vacant chairs + seated people (approximation of total seating in view) */
  totalSeats: number;
  occupancyPct: number;
  /** laptops per seat in view, as a percentage (workstation density) */
  workstationDensityPct: number;
  availability: Availability;
  /** Laptops are used as a proxy for power-outlet demand; outlets are not detected. */
  outletDemand: OutletDemand;
}

// Tunable thresholds. Adjust after trying the app in a real cafe.
const FILLING_AT_OCCUPANCY_PCT = 75;
const OUTLET_MEDIUM_AT = 0.25; // laptops / seats
const OUTLET_HIGH_AT = 0.6;

export function deriveTelemetry(c: Counts): Telemetry {
  const totalSeats = c.vacant + c.occupied;
  const occupancyPct = totalSeats > 0 ? Math.round((c.occupied / totalSeats) * 100) : 0;
  const laptopRatio = totalSeats > 0 ? c.laptops / totalSeats : 0;
  const workstationDensityPct = Math.min(100, Math.round(laptopRatio * 100));

  let availability: Availability;
  if (totalSeats === 0) availability = 'none';
  else if (c.vacant === 0) availability = 'full';
  else if (occupancyPct >= FILLING_AT_OCCUPANCY_PCT) availability = 'filling';
  else availability = 'available';

  const outletDemand: OutletDemand =
    laptopRatio >= OUTLET_HIGH_AT ? 'high' : laptopRatio >= OUTLET_MEDIUM_AT ? 'medium' : 'low';

  return { totalSeats, occupancyPct, workstationDensityPct, availability, outletDemand };
}

export const AVAILABILITY_LABEL: Record<Availability, string> = {
  none: 'No seats in view',
  available: 'Seats available',
  filling: 'Filling up',
  full: 'Full',
};

export const AVAILABILITY_COLOR: Record<Availability, string> = {
  none: '#94A3B8',
  available: '#10B981',
  filling: '#F59E0B',
  full: '#F43F5E',
};

export const OUTLET_LABEL: Record<OutletDemand, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};