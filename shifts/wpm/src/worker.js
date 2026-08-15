const ALLOWED_ORIGINS = new Set([
  "https://cuckfactory.github.io",
  "https://wpm.quiet-archive-73.workers.dev"
]);

const SESSION_DAYS = 180;
const GAME_ID_WPM = "wpm-cuck";

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    ...(allowOrigin ? { "access-control-allow-origin": allowOrigin } : {}),
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };
}

function jsonResponse(request, data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(request),
      ...extraHeaders
    }
  });
}

function cleanHandle(value) {
  return String(value ?? "")
    .trim()
    .replace(/^@+/, "")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .slice(0, 30);
}

function normalizeHandle(value) {
  return cleanHandle(value).toLowerCase();
}

function cleanWallet(value) {
  return String(value ?? "").trim().slice(0, 160);
}

function normalizeWallet(value) {
  return cleanWallet(value).toLowerCase();
}

function validNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(max, Math.max(min, number));
}

function randomHex(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomFactoryCode(groups = 4, charsPerGroup = 4) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(groups * charsPerGroup);
  crypto.getRandomValues(bytes);
  let out = "";

  for (let i = 0; i < bytes.length; i++) {
    if (i && i % charsPerGroup === 0) out += "-";
    out += alphabet[bytes[i] % alphabet.length];
  }

  return `CF-${out}`;
}

function normalizeRecoveryKey(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

async function sha256Hex(value) {
  const data = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", data);

  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function bearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function addDaysIso(days) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

function scoreToApiRecord(score, rank = null) {
  const record = {
    factoryFileNumber: Number(score.id),
    factoryFile: `CF-${String(score.id).padStart(6, "0")}`,
    playerHandle: score.player_handle,
    wpm: Number(score.wpm),
    accuracy: Number(score.accuracy),
    rejected: Number(score.rejected),
    bestCombo: Number(score.best_combo),
    factoryScore: Number(score.factory_score),
    carrotDistance: Number(score.carrot_distance),
    createdAt: score.created_at
  };

  if (rank !== null) record.rank = rank;
  return record;
}

async function createSession(env, employeeId) {
  const token = randomHex(32);
  const sessionHash = await sha256Hex(token);
  const expiresAt = addDaysIso(SESSION_DAYS);

  await env.DB.prepare(`
    INSERT INTO employee_sessions (
      employee_id,
      session_hash,
      expires_at
    )
    VALUES (?, ?, ?)
  `)
    .bind(employeeId, sessionHash, expiresAt)
    .run();

  return {
    token,
    expiresAt
  };
}

async function authenticate(request, env) {
  const token = bearerToken(request);
  if (!token) return null;

  const hash = await sha256Hex(token);

  const row = await env.DB.prepare(`
    SELECT
      s.id AS session_id,
      s.employee_id,
      e.*
    FROM employee_sessions s
    INNER JOIN employees e
      ON e.id = s.employee_id
    WHERE s.session_hash = ?
      AND s.revoked_at IS NULL
      AND datetime(s.expires_at) > datetime('now')
      AND e.status = 'ACTIVE'
    LIMIT 1
  `)
    .bind(hash)
    .first();

  if (!row) return null;

  env.DB.prepare(`
    UPDATE employee_sessions
    SET last_seen_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `)
    .bind(row.session_id)
    .run()
    .catch(() => {});

  return row;
}

async function employeeSummary(env, employee) {
  const shiftStats = await env.DB.prepare(`
    SELECT
      COUNT(*) AS total_shifts,
      COUNT(DISTINCT game_id) AS games_played
    FROM scores
    WHERE employee_id = ?
      AND validation_status IN ('valid', 'review')
  `)
    .bind(employee.id)
    .first();

  const bestRows = await env.DB.prepare(`
    SELECT
      game_id,
      COUNT(*) AS shifts,
      MAX(factory_score) AS best_factory_score,
      MAX(wpm) AS best_wpm
    FROM scores
    WHERE employee_id = ?
      AND validation_status IN ('valid', 'review')
    GROUP BY game_id
    ORDER BY game_id ASC
  `)
    .bind(employee.id)
    .all();

  const referralStats = await env.DB.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(
        CASE
          WHEN status = 'QUALIFIED' THEN 1
          ELSE 0
        END
      ) AS qualified
    FROM referrals
    WHERE referrer_employee_id = ?
  `)
    .bind(employee.id)
    .first();

  const risk = await env.DB.prepare(`
    SELECT COUNT(*) AS unresolved
    FROM risk_flags
    WHERE employee_id = ?
      AND resolved_at IS NULL
  `)
    .bind(employee.id)
    .first();

  const gameRecords = {};

  for (const row of bestRows.results ?? []) {
    gameRecords[row.game_id] = {
      shifts: Number(row.shifts ?? 0),
      bestFactoryScore: Number(row.best_factory_score ?? 0),
      bestWpm: Number(row.best_wpm ?? 0)
    };
  }

  return {
    employeeId: employee.employee_code,
    handle: `@${employee.x_handle}`,
    wallet: employee.wallet,
    postUrl: employee.post_url,

    assessment: {
      classification: employee.classification,
      score: Number(employee.assessment_score ?? 0),
      power: Number(employee.cuckpower ?? 0)
    },

    cuckpower: Number(employee.cuckpower ?? 0),
    cuckdropPoints: Number(employee.cuckdrop_points ?? 0),
    status: employee.status,

    shiftsCompleted: Number(shiftStats?.total_shifts ?? 0),
    gamesPlayed: Number(shiftStats?.games_played ?? 0),
    games: gameRecords,

    recruits: Number(referralStats?.total ?? 0),
    qualifiedRecruits: Number(referralStats?.qualified ?? 0),

    referralCode: employee.referral_code,
    createdAt: employee.created_at,

    reviewState:
      Number(risk?.unresolved ?? 0) > 0
        ? "RECORDED"
        : "NORMAL"
  };
}

async function insertEvent(
  env,
  employeeId,
  type,
  label,
  detail = {},
  eventId = crypto.randomUUID()
) {
  await env.DB.prepare(`
    INSERT OR IGNORE INTO employee_events (
      event_id,
      employee_id,
      event_type,
      event_label,
      detail_json
    )
    VALUES (?, ?, ?, ?, ?)
  `)
    .bind(
      eventId,
      employeeId,
      String(type || "").slice(0, 80),
      String(label || type || "").slice(0, 120),
      JSON.stringify(detail ?? {})
    )
    .run();

  return eventId;
}

async function addRiskFlag(
  env,
  employeeId,
  type,
  severity,
  detail = {}
) {
  await env.DB.prepare(`
    INSERT INTO risk_flags (
      employee_id,
      flag_type,
      severity,
      detail_json
    )
    VALUES (?, ?, ?, ?)
  `)
    .bind(
      employeeId,
      String(type).slice(0, 80),
      Number(severity || 10),
      JSON.stringify(detail)
    )
    .run();
}

function scoreRisk({
  wpm,
  accuracy,
  factoryScore,
  rejected,
  bestCombo
}) {
  const flags = [];

  if (wpm > 220) {
    flags.push(["EXTREME_WPM", 60]);
  }

  if (wpm > 300) {
    flags.push(["IMPOSSIBLE_WPM", 95]);
  }

  if (factoryScore > 9999) {
    flags.push(["OUT_OF_RANGE_FACTORY_SCORE", 95]);
  }

  if (bestCombo > 150) {
    flags.push(["OUT_OF_RANGE_COMBO", 60]);
  }

  if (rejected > 5000) {
    flags.push(["ABNORMAL_REJECTED_KEYS", 40]);
  }

  if (accuracy > 100 || accuracy < 0) {
    flags.push(["INVALID_ACCURACY", 95]);
  }

  return flags;
}

async function currentBest(env, employeeId, gameId) {
  const row = await env.DB.prepare(`
    SELECT MAX(factory_score) AS best
    FROM scores
    WHERE employee_id = ?
      AND game_id = ?
      AND validation_status IN ('valid', 'review')
  `)
    .bind(employeeId, gameId)
    .first();

  return Number(row?.best ?? 0);
}

function pointsForShift(factoryScore, previousBest) {
  const base = 25;

  const oldBestBonus = Math.floor(
    Math.max(0, previousBest) / 100
  );

  const newBestBonus = Math.floor(
    Math.max(0, factoryScore) / 100
  );

  const improvement = Math.max(
    0,
    newBestBonus - oldBestBonus
  );

  return {
    base,
    improvement,
    total: base + improvement
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request)
      });
    }

    /*
     * HEALTH CHECK
     */
    if (
      url.pathname === "/api/health" &&
      request.method === "GET"
    ) {
      try {
        const [scores, employees] = await env.DB.batch([
          env.DB.prepare(
            "SELECT COUNT(*) AS n FROM scores"
          ),
          env.DB.prepare(
            "SELECT COUNT(*) AS n FROM employees"
          )
        ]);

        return jsonResponse(request, {
          status: "ok",
          worker: "running",
          database: "connected",
          scoresRecorded: Number(
            scores.results?.[0]?.n ?? 0
          ),
          employeesRecorded: Number(
            employees.results?.[0]?.n ?? 0
          )
        });
      } catch (error) {
        return jsonResponse(
          request,
          {
            status: "error",
            worker: "running",
            database: "query_failed",
            message: String(
              error?.message ?? error
            )
          },
          500
        );
      }
    }

    /*
     * PRE-CHECK X + WALLET
     */
    if (
      url.pathname === "/api/employee/check" &&
      request.method === "POST"
    ) {
      try {
        const body = await request.json();

        const x = normalizeHandle(body.handle);
        const wallet = normalizeWallet(body.wallet);

        if (!x || wallet.length < 4) {
          return jsonResponse(
            request,
            {
              status: "error",
              message:
                "Handle and wallet are required."
            },
            400
          );
        }

        const [handleRow, walletRow] =
          await env.DB.batch([
            env.DB.prepare(`
              SELECT COUNT(*) AS n
              FROM employees
              WHERE x_handle_normalized = ?
            `).bind(x),

            env.DB.prepare(`
              SELECT COUNT(*) AS n
              FROM employees
              WHERE wallet_normalized = ?
            `).bind(wallet)
          ]);

        const duplicateHandle =
          Number(
            handleRow.results?.[0]?.n ?? 0
          ) > 0;

        const duplicateWallet =
          Number(
            walletRow.results?.[0]?.n ?? 0
          ) > 0;

        return jsonResponse(request, {
          status: "ok",
          canContinue: true,
          duplicateHandle,
          duplicateWallet,
          reviewRequired:
            duplicateHandle ||
            duplicateWallet
        });
      } catch (error) {
        return jsonResponse(
          request,
          {
            status: "error",
            message:
              "Registration check failed.",
            detail: String(
              error?.message ?? error
            )
          },
          500
        );
      }
    }

    /*
     * ACTIVATE EMPLOYEE RECORD
     */
    if (
      url.pathname === "/api/employee/activate" &&
      request.method === "POST"
    ) {
      try {
        const body = await request.json();

        const xHandle = cleanHandle(
          body.handle
        );

        const xNorm = normalizeHandle(
          body.handle
        );

        const wallet = cleanWallet(
          body.wallet
        );

        const walletNorm = normalizeWallet(
          body.wallet
        );

        const postUrl = String(
          body.postUrl ?? ""
        )
          .trim()
          .slice(0, 500);

        const classification = String(
          body.assessment?.classification ??
          body.classification ??
          "UNCLASSIFIED"
        )
          .trim()
          .slice(0, 80);

        const assessmentScore = Math.round(
          validNumber(
            body.assessment?.score ??
            body.assessmentScore ??
            0,
            0,
            100000
          ) ?? 0
        );

        const cuckpower = Math.round(
          validNumber(
            body.assessment?.power ??
            body.cuckpower ??
            0,
            0,
            100000000
          ) ?? 0
        );

        if (
          !xHandle ||
          wallet.length < 4
        ) {
          return jsonResponse(
            request,
            {
              status: "error",
              message:
                "A valid X handle and wallet are required."
            },
            400
          );
        }

        const [handleDup, walletDup] =
          await env.DB.batch([
            env.DB.prepare(`
              SELECT COUNT(*) AS n
              FROM employees
              WHERE x_handle_normalized = ?
            `).bind(xNorm),

            env.DB.prepare(`
              SELECT COUNT(*) AS n
              FROM employees
              WHERE wallet_normalized = ?
            `).bind(walletNorm)
          ]);

        const duplicateHandle =
          Number(
            handleDup.results?.[0]?.n ?? 0
          ) > 0;

        const duplicateWallet =
          Number(
            walletDup.results?.[0]?.n ?? 0
          ) > 0;

        const referralCode =
          randomFactoryCode(2, 4)
            .replace(/^CF-/, "REF-");

        const inserted =
          await env.DB.prepare(`
            INSERT INTO employees (
              x_handle,
              x_handle_normalized,
              wallet,
              wallet_normalized,
              post_url,
              classification,
              assessment_score,
              cuckpower,
              cuckdrop_points,
              referral_code
            )
            VALUES (
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            )
          `)
            .bind(
              xHandle,
              xNorm,
              wallet,
              walletNorm,
              postUrl || null,
              classification,
              assessmentScore,
              cuckpower,
              cuckpower,
              referralCode
            )
            .run();

        const employeeId = Number(
          inserted.meta?.last_row_id ?? 0
        );

        if (!employeeId) {
          throw new Error(
            "Employee row was not created."
          );
        }

        const employeeCode =
          `CF-${String(employeeId)
            .padStart(6, "0")}`;

        await env.DB.prepare(`
          UPDATE employees
          SET
            employee_code = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
          .bind(
            employeeCode,
            employeeId
          )
          .run();

        const accessKey =
          randomFactoryCode(4, 4);

        const accessHash =
          await sha256Hex(
            normalizeRecoveryKey(
              accessKey
            )
          );

        await env.DB.prepare(`
          INSERT INTO recovery_keys (
            employee_id,
            key_hash
          )
          VALUES (?, ?)
        `)
          .bind(
            employeeId,
            accessHash
          )
          .run();

        const session =
          await createSession(
            env,
            employeeId
          );

        if (duplicateHandle) {
          await addRiskFlag(
            env,
            employeeId,
            "DUPLICATE_X_HANDLE",
            45,
            {
              xHandle:
                `@${xHandle}`
            }
          );
        }

        if (duplicateWallet) {
          await addRiskFlag(
            env,
            employeeId,
            "DUPLICATE_WALLET",
            60,
            {
              wallet
            }
          );
        }

        const activationEvent =
          crypto.randomUUID();

        await insertEvent(
          env,
          employeeId,
          "employee_activated",
          "EMPLOYEE RECORD ACTIVATED",
          {
            duplicateHandle,
            duplicateWallet
          },
          activationEvent
        );

        await env.DB.prepare(`
          INSERT INTO points_ledger (
            employee_id,
            event_id,
            source_type,
            source_id,
            delta,
            balance_after,
            detail_json
          )
          VALUES (
            ?,
            ?,
            'assessment',
            ?,
            ?,
            ?,
            ?
          )
        `)
          .bind(
            employeeId,
            activationEvent,
            employeeCode,
            cuckpower,
            cuckpower,
            JSON.stringify({
              reason:
                "Initial Cuckpower transferred into Cuckdrop Points."
            })
          )
          .run();

        const employee =
          await env.DB.prepare(`
            SELECT *
            FROM employees
            WHERE id = ?
          `)
            .bind(employeeId)
            .first();

        return jsonResponse(
          request,
          {
            status: "ok",
            message:
              "Employee record activated.",

            employee:
              await employeeSummary(
                env,
                employee
              ),

            sessionToken:
              session.token,

            sessionExpiresAt:
              session.expiresAt,

            factoryAccessKey:
              accessKey,

            duplicateHandle,
            duplicateWallet,

            reviewRequired:
              duplicateHandle ||
              duplicateWallet
          },
          201
        );
      } catch (error) {
        return jsonResponse(
          request,
          {
            status: "error",
            message:
              "Employee record could not be activated.",
            detail: String(
              error?.message ?? error
            )
          },
          500
        );
      }
    }    /*
     * RESTORE ON NEW DEVICE
     */
    if (
      url.pathname === "/api/employee/restore" &&
      request.method === "POST"
    ) {
      try {
        const body = await request.json();

        const normalized =
          normalizeRecoveryKey(
            body.accessKey
          );

        if (normalized.length < 12) {
          return jsonResponse(
            request,
            {
              status: "error",
              message:
                "Invalid Factory Access Key."
            },
            400
          );
        }

        const hash =
          await sha256Hex(
            normalized
          );

        const employee =
          await env.DB.prepare(`
            SELECT e.*
            FROM recovery_keys r
            INNER JOIN employees e
              ON e.id = r.employee_id
            WHERE r.key_hash = ?
              AND r.revoked_at IS NULL
              AND e.status = 'ACTIVE'
            LIMIT 1
          `)
            .bind(hash)
            .first();

        if (!employee) {
          return jsonResponse(
            request,
            {
              status: "error",
              message:
                "Factory Access Key not recognized."
            },
            404
          );
        }

        await env.DB.prepare(`
          UPDATE recovery_keys
          SET last_used_at = CURRENT_TIMESTAMP
          WHERE key_hash = ?
        `)
          .bind(hash)
          .run();

        const session =
          await createSession(
            env,
            employee.id
          );

        await insertEvent(
          env,
          employee.id,
          "device_restored",
          "EMPLOYEE RECORD RESTORED ON DEVICE",
          {}
        );

        return jsonResponse(request, {
          status: "ok",

          employee:
            await employeeSummary(
              env,
              employee
            ),

          sessionToken:
            session.token,

          sessionExpiresAt:
            session.expiresAt
        });

      } catch (error) {
        return jsonResponse(
          request,
          {
            status: "error",
            message:
              "Employee record could not be restored.",
            detail: String(
              error?.message ?? error
            )
          },
          500
        );
      }
    }

    /*
     * GET CURRENT EMPLOYEE
     */
    if (
      (
        url.pathname === "/api/session" ||
        url.pathname === "/api/employee/me"
      ) &&
      request.method === "GET"
    ) {
      try {
        const employee =
          await authenticate(
            request,
            env
          );

        if (!employee) {
          return jsonResponse(request, {
            status: "ok",
            employee: null
          });
        }

        return jsonResponse(request, {
          status: "ok",

          employee:
            await employeeSummary(
              env,
              employee
            )
        });

      } catch (error) {
        return jsonResponse(
          request,
          {
            status: "error",
            message:
              "Employee record could not be loaded.",
            detail: String(
              error?.message ?? error
            )
          },
          500
        );
      }
    }

    /*
     * CLIENT EVENT LOG
     */
    if (
      url.pathname === "/api/events" &&
      request.method === "POST"
    ) {
      try {
        const employee =
          await authenticate(
            request,
            env
          );

        if (!employee) {
          return jsonResponse(
            request,
            {
              status: "error",
              message:
                "Employee session required."
            },
            401
          );
        }

        const body =
          await request.json();

        const event =
          body.event ?? body;

        await insertEvent(
          env,
          employee.id,
          event.type ??
            "client_event",
          event.label ??
            event.type ??
            "CLIENT EVENT",
          event.detail ?? {},
          String(
            event.id ??
            crypto.randomUUID()
          ).slice(0, 120)
        );

        return jsonResponse(
          request,
          {
            status: "ok"
          }
        );

      } catch (error) {
        return jsonResponse(
          request,
          {
            status: "error",
            message:
              "Event could not be recorded.",
            detail: String(
              error?.message ?? error
            )
          },
          500
        );
      }
    }

    /*
     * SAVE WPM SCORE
     */
    if (
      url.pathname === "/api/submit-score" &&
      request.method === "POST"
    ) {
      try {
        const body =
          await request.json();

        const employee =
          await authenticate(
            request,
            env
          );

        const playerHandle =
          employee
            ? employee.x_handle
            : cleanHandle(
                body.playerHandle
              );

        const wpm =
          validNumber(
            body.wpm,
            0,
            400
          );

        const accuracy =
          validNumber(
            body.accuracy,
            0,
            100
          );

        const rejected =
          validNumber(
            body.rejected,
            0,
            10000
          );

        const bestCombo =
          validNumber(
            body.bestCombo,
            0,
            10000
          );

        const factoryScore =
          validNumber(
            body.factoryScore,
            0,
            100000000
          );

        const carrotDistance =
          validNumber(
            body.carrotDistance,
            0.1,
            99.9
          );

        const shiftId =
          String(
            body.shiftId ?? ""
          )
            .trim()
            .slice(0, 100);

        const gameId =
          String(
            body.gameId ??
            GAME_ID_WPM
          )
            .trim()
            .slice(0, 80);

        if (!playerHandle) {
          return jsonResponse(
            request,
            {
              status: "error",
              message:
                "A valid player handle is required."
            },
            400
          );
        }

        if (
          wpm === null ||
          accuracy === null ||
          rejected === null ||
          bestCombo === null ||
          factoryScore === null ||
          carrotDistance === null ||
          !shiftId
        ) {
          return jsonResponse(
            request,
            {
              status: "error",
              message:
                "Invalid or incomplete score data."
            },
            400
          );
        }

        const flags =
          scoreRisk({
            wpm,
            accuracy,
            factoryScore,
            rejected,
            bestCombo
          });

        const validationStatus =
          employee
            ? (
                flags.length
                  ? "review"
                  : "valid"
              )
            : "legacy";

        const previousBest =
          employee
            ? await currentBest(
                env,
                employee.id,
                gameId
              )
            : 0;

        const insertResult =
          await env.DB.prepare(`
            INSERT INTO scores (
              player_handle,
              wpm,
              accuracy,
              rejected,
              best_combo,
              factory_score,
              shift_id,
              carrot_distance,
              employee_id,
              game_id,
              validation_status
            )
            VALUES (
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            )
          `)
            .bind(
              playerHandle,
              Math.round(wpm),
              accuracy,
              Math.round(rejected),
              Math.round(bestCombo),
              Math.round(factoryScore),
              shiftId,
              carrotDistance,
              employee?.id ?? null,
              gameId,
              validationStatus
            )
            .run();

        const factoryFileNumber =
          Number(
            insertResult.meta
              ?.last_row_id ?? 0
          );

        let pointsDelta = 0;

        let newBalance =
          employee
            ? Number(
                employee
                  .cuckdrop_points ?? 0
              )
            : null;

        let newBest = false;

        if (employee) {
          for (
            const [
              type,
              severity
            ] of flags
          ) {
            await addRiskFlag(
              env,
              employee.id,
              type,
              severity,
              {
                shiftId,
                gameId,
                wpm,
                accuracy,
                factoryScore,
                bestCombo,
                rejected
              }
            );
          }

          const pointParts =
            pointsForShift(
              Math.round(
                factoryScore
              ),
              previousBest
            );

          pointsDelta =
            pointParts.total;

          newBest =
            Math.round(
              factoryScore
            ) > previousBest;

          newBalance =
            Number(
              employee
                .cuckdrop_points ?? 0
            ) +
            pointsDelta;

          const eventId =
            crypto.randomUUID();

          await env.DB.batch([
            env.DB.prepare(`
              UPDATE employees
              SET
                cuckdrop_points = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `)
              .bind(
                newBalance,
                employee.id
              ),

            env.DB.prepare(`
              INSERT INTO employee_events (
                event_id,
                employee_id,
                event_type,
                event_label,
                detail_json
              )
              VALUES (
                ?,
                ?,
                'shift_completed',
                'WPM CUCK SHIFT COMPLETED',
                ?
              )
            `)
              .bind(
                eventId,
                employee.id,
                JSON.stringify({
                  shiftId,
                  gameId,
                  factoryScore:
                    Math.round(
                      factoryScore
                    ),
                  wpm:
                    Math.round(
                      wpm
                    ),
                  accuracy,
                  validationStatus,
                  pointsDelta,
                  newBest
                })
              ),

            env.DB.prepare(`
              INSERT INTO points_ledger (
                employee_id,
                event_id,
                source_type,
                source_id,
                delta,
                balance_after,
                detail_json
              )
              VALUES (
                ?,
                ?,
                'shift',
                ?,
                ?,
                ?,
                ?
              )
            `)
              .bind(
                employee.id,
                eventId,
                shiftId,
                pointsDelta,
                newBalance,
                JSON.stringify({
                  shiftBase:
                    pointParts.base,

                  personalBestImprovement:
                    pointParts.improvement,

                  gameId,

                  validationStatus
                })
              )
          ]);
        }

        return jsonResponse(
          request,
          {
            status: "ok",

            message:
              employee
                ? "Shift recorded to permanent Employee Record."
                : "Legacy leaderboard shift recorded.",

            factoryFileNumber,

            factoryFile:
              `CF-${String(
                factoryFileNumber
              ).padStart(
                6,
                "0"
              )}`,

            employeeRecorded:
              Boolean(employee),

            validationStatus,

            points:
              employee
                ? {
                    delta:
                      pointsDelta,

                    balance:
                      newBalance,

                    newBest
                  }
                : null
          },
          201
        );

      } catch (error) {
        const message =
          String(
            error?.message ??
            error
          );

        if (
          message
            .toLowerCase()
            .includes(
              "unique"
            )
        ) {
          return jsonResponse(
            request,
            {
              status: "error",
              message:
                "This shift has already been recorded."
            },
            409
          );
        }

        return jsonResponse(
          request,
          {
            status: "error",
            message:
              "The shift could not be recorded.",
            detail:
              message
          },
          500
        );
      }
    }

    /*
     * LEADERBOARD
     */
    if (
      url.pathname === "/api/leaderboard" &&
      request.method === "GET"
    ) {
      try {
        const period =
          url.searchParams.get(
            "period"
          ) === "all"
            ? "all"
            : "week";

        const whereClause =
          period === "week"
            ? "WHERE datetime(created_at) >= datetime('now', '-7 days')"
            : "";

        const result =
          await env.DB.prepare(`
            SELECT
              id,
              player_handle,
              wpm,
              accuracy,
              rejected,
              best_combo,
              factory_score,
              carrot_distance,
              created_at
            FROM scores
            ${whereClause}
            ORDER BY
              factory_score DESC,
              accuracy DESC,
              wpm DESC
            LIMIT 10
          `)
            .all();

        const leaderboard =
          (
            result.results ??
            []
          ).map(
            (
              score,
              index
            ) =>
              scoreToApiRecord(
                score,
                index + 1
              )
          );

        return jsonResponse(
          request,
          {
            status: "ok",
            period,
            leaderboard
          }
        );

      } catch (error) {
        return jsonResponse(
          request,
          {
            status: "error",
            message:
              "The leaderboard could not be loaded.",
            detail: String(
              error?.message ?? error
            )
          },
          500
        );
      }
    }

    /*
     * RACE OPPONENTS
     */
    if (
      url.pathname === "/api/race-opponents" &&
      request.method === "GET"
    ) {
      try {
        const requestedLimit =
          Number(
            url.searchParams.get(
              "limit"
            ) ?? 3
          );

        const limit =
          Math.min(
            3,
            Math.max(
              1,
              Number.isFinite(
                requestedLimit
              )
                ? Math.round(
                    requestedLimit
                  )
                : 3
            )
          );

        const result =
          await env.DB.prepare(`
            WITH best_scores AS (
              SELECT
                player_handle,
                MAX(factory_score)
                  AS best_factory_score
              FROM scores
              WHERE wpm > 0
                AND accuracy > 0
                AND factory_score > 0
              GROUP BY player_handle
            ),

            ranked_players AS (
              SELECT
                player_handle,
                best_factory_score,
                ROW_NUMBER() OVER (
                  ORDER BY
                    best_factory_score DESC,
                    player_handle ASC
                ) AS global_rank
              FROM best_scores
            ),

            latest_runs AS (
              SELECT
                player_handle,
                MAX(id)
                  AS latest_id
              FROM scores
              WHERE wpm > 0
                AND accuracy > 0
                AND factory_score > 0
              GROUP BY player_handle
            )

            SELECT
              s.id,
              s.player_handle,
              s.wpm,
              s.accuracy,
              s.rejected,
              s.best_combo,
              s.factory_score,
              s.carrot_distance,
              s.created_at,
              ranked_players.global_rank,
              ranked_players.best_factory_score

            FROM latest_runs

            INNER JOIN scores AS s
              ON s.id =
                latest_runs.latest_id

            INNER JOIN ranked_players
              ON ranked_players.player_handle =
                s.player_handle

            ORDER BY RANDOM()
            LIMIT ?
          `)
            .bind(limit)
            .all();

        const opponents =
          (
            result.results ??
            []
          ).map(
            (score) => ({
              ...scoreToApiRecord(
                score
              ),

              globalRank:
                Number(
                  score.global_rank
                ),

              bestFactoryScore:
                Number(
                  score
                    .best_factory_score
                )
            })
          );

        return jsonResponse(
          request,
          {
            status: "ok",
            opponents
          }
        );

      } catch (error) {
        return jsonResponse(
          request,
          {
            status: "error",
            message:
              "Race opponents could not be loaded.",
            detail:
              String(
                error?.message ??
                error
              )
          },
          500
        );
      }
    }

    /*
     * PLAYER RANK
     */
    if (
      url.pathname === "/api/player-rank" &&
      request.method === "GET"
    ) {
      try {
        const playerHandle =
          cleanHandle(
            url.searchParams.get(
              "handle"
            )
          );

        if (!playerHandle) {
          return jsonResponse(
            request,
            {
              status: "error",
              message:
                "A valid player handle is required."
            },
            400
          );
        }

        const ranked =
          await env.DB.prepare(`
            WITH best_scores AS (
              SELECT
                player_handle,
                MAX(factory_score)
                  AS best_factory_score
              FROM scores
              WHERE wpm > 0
                AND accuracy > 0
                AND factory_score > 0
              GROUP BY player_handle
            ),

            ranked_players AS (
              SELECT
                player_handle,
                best_factory_score,
                ROW_NUMBER() OVER (
                  ORDER BY
                    best_factory_score DESC,
                    player_handle ASC
                ) AS global_rank
              FROM best_scores
            )

            SELECT
              player_handle,
              best_factory_score,
              global_rank
            FROM ranked_players
            ORDER BY global_rank ASC
          `)
            .all();

        const rows =
          ranked.results ?? [];

        const playerIndex =
          rows.findIndex(
            (row) =>
              String(
                row.player_handle
              ).toLowerCase() ===
              playerHandle
                .toLowerCase()
          );

        if (
          playerIndex === -1
        ) {
          return jsonResponse(
            request,
            {
              status: "ok",
              found: false,
              playerHandle
            }
          );
        }

        const player =
          rows[playerIndex];

        const nextTarget =
          playerIndex > 0
            ? rows[
                playerIndex - 1
              ]
            : null;

        const nearestBehind =
          playerIndex <
          rows.length - 1
            ? rows[
                playerIndex + 1
              ]
            : null;

        return jsonResponse(
          request,
          {
            status: "ok",

            found: true,

            totalPlayers:
              rows.length,

            player: {
              playerHandle:
                player
                  .player_handle,

              globalRank:
                Number(
                  player
                    .global_rank
                ),

              bestFactoryScore:
                Number(
                  player
                    .best_factory_score
                )
            },

            nextTarget:
              nextTarget
                ? {
                    playerHandle:
                      nextTarget
                        .player_handle,

                    globalRank:
                      Number(
                        nextTarget
                          .global_rank
                      ),

                    bestFactoryScore:
                      Number(
                        nextTarget
                          .best_factory_score
                      ),

                    pointsAhead:
                      Number(
                        nextTarget
                          .best_factory_score
                      ) -
                      Number(
                        player
                          .best_factory_score
                      )
                  }
                : null,

            nearestBehind:
              nearestBehind
                ? {
                    playerHandle:
                      nearestBehind
                        .player_handle,

                    globalRank:
                      Number(
                        nearestBehind
                          .global_rank
                      ),

                    bestFactoryScore:
                      Number(
                        nearestBehind
                          .best_factory_score
                      ),

                    pointsBehind:
                      Number(
                        player
                          .best_factory_score
                      ) -
                      Number(
                        nearestBehind
                          .best_factory_score
                      )
                  }
                : null
          }
        );

      } catch (error) {
        return jsonResponse(
          request,
          {
            status: "error",
            message:
              "Player rank could not be loaded.",
            detail:
              String(
                error?.message ??
                error
              )
          },
          500
        );
      }
    }

    /*
     * FAVICON
     */
    if (
      url.pathname === "/favicon.ico" &&
      request.method === "GET"
    ) {
      return new Response(
        null,
        {
          status: 204,
          headers: {
            "cache-control":
              "public, max-age=86400",
            ...corsHeaders(
              request
            )
          }
        }
      );
    }

    /*
     * UNKNOWN API ROUTE
     */
    if (
      url.pathname.startsWith(
        "/api/"
      )
    ) {
      return jsonResponse(
        request,
        {
          status: "error",
          message:
            "API route not found."
        },
        404
      );
    }

    /*
     * STATIC ASSETS FALLBACK
     */
    if (
      env.ASSETS &&
      typeof env.ASSETS.fetch ===
        "function"
    ) {
      return env.ASSETS.fetch(
        request
      );
    }

    return new Response(
      "Not found",
      {
        status: 404,
        headers: {
          "content-type":
            "text/plain; charset=utf-8",
          ...corsHeaders(
            request
          )
        }
      }
    );
  }
};
