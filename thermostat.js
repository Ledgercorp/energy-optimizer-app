// Thermostat control seam.
//
// Today the only working "integration" is a person reading the display and pressing buttons.
// A future adapter can send commands only when ALL of these hold:
//   1. the capability supports writes,
//   2. an adapter for it is registered in ADAPTERS,
//   3. controlVerified — the interface is documented and authorized by Delmarva or the manufacturer,
//   4. controlApproved — the household explicitly approved sending commands.
// Never add an adapter that uses the side jack, utility RF/paging, or private/undocumented utility APIs.

export const CAPABILITIES = {
  manual_only: {
    label: 'Manual only',
    status: 'active',
    detail: 'You read the display and program the thermostat by hand. Always available.',
    write: false,
  },
  utility_portal_unavailable: {
    label: 'Delmarva web portal',
    status: 'unavailable',
    detail: 'Program Your Thermostat → View Thermostat failed (apigateway-east.exeloncorp.com could not be resolved). Delaware Energy Wise Rewards was paused May 31, 2026.',
    write: false,
  },
  utility_portal_supported: {
    label: 'Delmarva web portal (if restored)',
    status: 'disabled',
    detail: 'The historic portal was one-way: it could send schedules but never confirm delivery or report temperature, and saving could overwrite local changes. Stays off until Delmarva confirms support.',
    write: true,
  },
  verified_local_interface: {
    label: 'Verified local interface',
    status: 'none known',
    detail: 'No documented local API, Wi-Fi or service-port protocol exists for this IT900-family unit. The side jack has no published pinout and must not be used.',
    write: true,
  },
};

// Future adapters register here: { [capabilityId]: { writeSchedule(schedule) => Promise<{ confirmed: boolean, detail?: string }> } }
export const ADAPTERS = {};

export function controlStatus(state) {
  const cap = CAPABILITIES[state.capability];
  if (!cap?.write) return { enabled: false, reason: `${cap ? cap.label : 'Unknown interface'}: cannot send commands.` };
  if (!ADAPTERS[state.capability]) return { enabled: false, reason: `${cap.label}: no adapter implemented.` };
  if (state.controlVerified !== true) return { enabled: false, reason: `${cap.label}: not verified as an authorized interface.` };
  if (state.controlApproved !== true) return { enabled: false, reason: 'Waiting for your explicit approval.' };
  return { enabled: true, reason: 'Authorized interface verified and approved.' };
}

export const canWrite = (state) => controlStatus(state).enabled;

export async function sendSchedule(state, schedule) {
  const st = controlStatus(state);
  if (!st.enabled) return { ok: false, reason: st.reason };
  try {
    const r = await ADAPTERS[state.capability].writeSchedule(schedule);
    // One-way links can't confirm delivery; never report that as success.
    return r?.confirmed ? { ok: true, detail: r.detail || 'Thermostat confirmed the schedule.' } : { ok: false, reason: 'Sent, but the thermostat did not confirm it. Check the display.' };
  } catch (e) {
    return { ok: false, reason: `Send failed: ${e.message}` };
  }
}
