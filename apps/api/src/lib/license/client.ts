/**
 * Cliente HTTP hacia el servidor central de licencias.
 * Llama a /licenses/validate y /licenses/heartbeat.
 */

import os from 'os';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getMachineFingerprint, getInstallationId } from './fingerprint.js';

const TIMEOUT_MS = 15_000;

interface ValidateResponse {
  valid: boolean;
  mode: 'normal' | 'restrictive' | 'shutdown';
  status: string;
  clinic_name: string;
  plan: string;
  features: string[];
  expires_at: string;
}

interface HeartbeatResponse {
  ok: boolean;
  mode: 'normal' | 'restrictive' | 'shutdown';
}

function getMetrics() {
  const mem = process.memoryUsage();
  const cpus = os.cpus();
  const loadAvg = os.loadavg();
  return {
    cpu_percent: cpus.length > 0 ? Math.round((loadAvg[0] ?? 0) / cpus.length * 100) : 0,
    memory_mb: Math.round(mem.rss / 1024 / 1024),
    uptime_hours: Math.round(process.uptime() / 3600),
  };
}

async function licenseRequest<T>(path: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${config.LICENSE_SERVER_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-License-Key': config.LICENSE_KEY,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const data = await res.json() as T;
    if (!res.ok) {
      throw new Error(`License server ${res.status}: ${JSON.stringify(data)}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function validateLicense(): Promise<ValidateResponse> {
  return licenseRequest<ValidateResponse>('/licenses/validate', {
    installation_id: getInstallationId(),
    machine_fingerprint: getMachineFingerprint(),
    version: config.APP_VERSION,
  });
}

export async function sendHeartbeat(): Promise<HeartbeatResponse> {
  return licenseRequest<HeartbeatResponse>('/licenses/heartbeat', {
    installation_id: getInstallationId(),
    machine_fingerprint: getMachineFingerprint(),
    version: config.APP_VERSION,
    metrics: getMetrics(),
  });
}

export { logger };
