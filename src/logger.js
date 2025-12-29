const LEVELS = {
  silent: 0,
  error: 10,
  warn: 20,
  info: 30,
  debug: 40,
};

function normalizeLevel(level) {
  const v = String(level ?? "info").trim().toLowerCase();
  return LEVELS[v] != null ? v : "info";
}

function shouldLog(currentLevel, msgLevel) {
  return LEVELS[msgLevel] <= LEVELS[currentLevel];
}

function nowIso() {
  return new Date().toISOString();
}

function formatLine({ level, component, message, meta }) {
  const base = `${nowIso()} ${level.toUpperCase()}${component ? ` [${component}]` : ""} ${message}`;
  if (meta == null) return base;

  try {
    return `${base} ${JSON.stringify(meta)}`;
  } catch {
    return `${base} ${String(meta)}`;
  }
}

export function createLogger({ level, component } = {}) {
  const configured = normalizeLevel(level ?? process.env.LOG_LEVEL ?? "info");
  const baseComponent = component ? String(component) : "";

  const emit = (msgLevel, message, meta) => {
    if (!shouldLog(configured, msgLevel)) return;

    const line = formatLine({
      level: msgLevel,
      component: baseComponent,
      message: String(message ?? ""),
      meta,
    });

    // En environnement Docker, on veut que tout arrive sur stdout
    // pour un traitement uniforme (collecteurs, docker logs, etc.).
    process.stdout.write(line + "\n");
  };

  return {
    level: configured,
    child(childComponent) {
      const next = baseComponent && childComponent ? `${baseComponent}:${childComponent}` : (childComponent ? String(childComponent) : baseComponent);
      return createLogger({ level: configured, component: next });
    },

    error(message, meta) {
      emit("error", message, meta);
    },
    warn(message, meta) {
      emit("warn", message, meta);
    },
    info(message, meta) {
      emit("info", message, meta);
    },
    debug(message, meta) {
      emit("debug", message, meta);
    },
  };
}
