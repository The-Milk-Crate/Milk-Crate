/**
 * Something that shouldn't be left halfway (a CD rip) can hold page changes: the app asks first
 * ("Hold On.") and only goes when you choose Proceed, after `onProceed` has run.
 */
export interface LeaveGuard {
  /** Runs when you choose to leave anyway (e.g. cancel the rip and delete its files). */
  onProceed: () => void;
}

let current: LeaveGuard | null = null;

export function setLeaveGuard(g: LeaveGuard | null) {
  current = g;
}

export const leaveGuard = () => current;
