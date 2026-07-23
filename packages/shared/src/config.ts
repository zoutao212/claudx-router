import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSON5 from "json5";
import { CONFIG_FILE } from "./constants";

export type ConfigRecord = Record<string, unknown>;

export interface ConfigDocument {
  value: ConfigRecord;
  revision: string;
  raw: string;
}

export interface ConfigIssue {
  path: string;
  message: string;
}

export interface ConfigWriteResult {
  backupPath?: string;
  revision: string;
  sourceWillBeFormatted: boolean;
}

const sensitiveKey = /^(api_?key|apikey|secret|token|password|private_?key)$/i;

const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");

const asRecord = (value: unknown): ConfigRecord | null => (
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ConfigRecord
    : null
);

export const validateConfig = (value: unknown): ConfigIssue[] => {
  const config = asRecord(value);
  if (!config) return [{ path: "$", message: "Configuration must be an object." }];

  const issues: ConfigIssue[] = [];
  if (config.PORT !== undefined) {
    const port = Number(config.PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      issues.push({ path: "PORT", message: "PORT must be an integer between 1 and 65535." });
    }
  }

  const providers = config.Providers ?? config.providers;
  if (providers !== undefined && !Array.isArray(providers)) {
    issues.push({ path: "Providers", message: "Providers must be an array." });
  }
  if (Array.isArray(providers)) {
    providers.forEach((provider, index) => {
      const item = asRecord(provider);
      const name = item?.name;
      if (typeof name !== "string" || name.trim() === "") {
        issues.push({ path: `Providers[${index}].name`, message: "Provider name is required." });
      }
      if (item?.models !== undefined && !Array.isArray(item.models)) {
        issues.push({ path: `Providers[${index}].models`, message: "Provider models must be an array." });
      }
    });
  }

  if (config.Router !== undefined && !asRecord(config.Router)) {
    issues.push({ path: "Router", message: "Router must be an object." });
  }
  return issues;
};

export const redactConfig = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactConfig);
  const record = asRecord(value);
  if (!record) return value;

  return Object.fromEntries(Object.entries(record).map(([key, child]) => [
    key,
    sensitiveKey.test(key) && typeof child === "string" && child.length > 0
      ? "[configured]"
      : redactConfig(child),
  ]));
};

export const preserveConfiguredSecrets = (updated: unknown, current: unknown): unknown => {
  if (Array.isArray(updated) && Array.isArray(current)) {
    return updated.map((value, index) => preserveConfiguredSecrets(value, current[index]));
  }

  const updatedRecord = asRecord(updated);
  const currentRecord = asRecord(current);
  if (!updatedRecord || !currentRecord) return updated;

  return Object.fromEntries(Object.entries(updatedRecord).map(([key, value]) => [
    key,
    sensitiveKey.test(key) && value === "[configured]"
      ? currentRecord[key]
      : preserveConfiguredSecrets(value, currentRecord[key]),
  ]));
};

export const readConfigDocument = async (configPath = CONFIG_FILE): Promise<ConfigDocument> => {
  const raw = await fs.readFile(configPath, "utf8");
  const value = asRecord(JSON5.parse(raw));
  if (!value) throw new Error("Configuration root must be an object.");
  return { raw, value, revision: hash(raw) };
};

const backupConfig = async (configPath: string): Promise<string | undefined> => {
  try {
    await fs.access(configPath);
  } catch {
    return undefined;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${configPath}.${timestamp}.bak`;
  await fs.copyFile(configPath, backupPath);

  const directory = path.dirname(configPath);
  const filename = path.basename(configPath);
  const backups = (await fs.readdir(directory))
    .filter((entry) => entry.startsWith(filename) && entry.endsWith(".bak"))
    .sort()
    .reverse();
  await Promise.all(backups.slice(3).map((entry) => fs.unlink(path.join(directory, entry))));
  return backupPath;
};

export const writeConfigDocument = async (
  value: unknown,
  expectedRevision?: string,
  configPath = CONFIG_FILE,
): Promise<ConfigWriteResult> => {
  const issues = validateConfig(value);
  if (issues.length > 0) {
    throw new Error(issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  let currentRevision: string | undefined;
  try {
    currentRevision = hash(await fs.readFile(configPath, "utf8"));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (expectedRevision && currentRevision && expectedRevision !== currentRevision) {
    throw new Error("Configuration changed on disk. Reload before saving.");
  }

  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const temporaryPath = path.join(path.dirname(configPath), `.${path.basename(configPath)}.${randomUUID()}.tmp`);
  const backupPath = await backupConfig(configPath);

  try {
    await fs.writeFile(temporaryPath, serialized, "utf8");
    const written = await fs.readFile(temporaryPath, "utf8");
    JSON5.parse(written);
    await fs.rename(temporaryPath, configPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }

  return {
    backupPath,
    revision: hash(serialized),
    sourceWillBeFormatted: true,
  };
};