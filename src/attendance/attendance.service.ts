import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';

// ── Mirrors Vastos_ARC's src/lib/attendanceApi.ts AttendanceRecord exactly ──
export interface AttendanceRecord {
  id: string;
  user_id: string;
  user_name: string;
  work_date: string;
  status: string;
  check_in_at: string | null;
  check_in_lat: number | null;
  check_in_lng: number | null;
  check_in_accuracy: number | null;
  check_in_label: string | null;
  check_out_at: string | null;
  check_out_lat: number | null;
  check_out_lng: number | null;
  check_out_accuracy: number | null;
  check_out_label: string | null;
  notes: string | null;
  marked_by: string | null;
}

export interface GeoFix {
  lat: number;
  lng: number;
  accuracy: number;
}

export interface ManualAttendanceInput {
  user_id: string;
  user_name: string;
  work_date: string;
  status: string;
  check_in_at?: string | null;
  check_out_at?: string | null;
  check_in_label?: string | null;
  check_out_label?: string | null;
  notes?: string | null;
}

const SELECT = `id, user_id, user_name, work_date, status, check_in_at, check_in_lat, check_in_lng,
  check_in_accuracy, check_in_label, check_out_at, check_out_lat, check_out_lng, check_out_accuracy,
  check_out_label, notes, marked_by`;

/**
 * Attendance register (Vastos_ARC's src/lib/attendanceApi.ts). checkOut() and
 * deleteAttendance() go through the generic /api/data/attendance_records
 * layer instead (plain update/delete by id, RLS-scoped) — see
 * db/table-registry.ts. checkIn()/saveManualAttendance() are upserts on
 * (firm_id,user_id,work_date), which that generic layer has no primitive
 * for, so they live here alongside the two filtered list reads.
 */
@Injectable()
export class AttendanceService {
  constructor(private readonly db: DatabaseService) {}

  listAttendance(
    authUid: string,
    opts: { from?: string; to?: string; userId?: string },
  ): Promise<AttendanceRecord[]> {
    return this.db.withCaller(authUid, async (client) => {
      const conditions = ['firm_id = current_firm_id()'];
      const values: unknown[] = [];
      if (opts.from) {
        values.push(opts.from);
        conditions.push(`work_date >= $${values.length}`);
      }
      if (opts.to) {
        values.push(opts.to);
        conditions.push(`work_date <= $${values.length}`);
      }
      if (opts.userId) {
        values.push(opts.userId);
        conditions.push(`user_id = $${values.length}`);
      }
      const { rows } = await client.query<AttendanceRecord>(
        `select ${SELECT} from attendance_records where ${conditions.join(' and ')} order by work_date desc`,
        values,
      );
      return rows;
    });
  }

  getTodayRecord(authUid: string, userId: string): Promise<AttendanceRecord | null> {
    return this.db.withCaller(authUid, async (client) => {
      const { rows } = await client.query<AttendanceRecord>(
        `select ${SELECT} from attendance_records
          where firm_id = current_firm_id() and user_id = $1 and work_date = current_date`,
        [userId],
      );
      return rows[0] ?? null;
    });
  }

  /** Upsert on (firm_id,user_id,work_date) — only touches the check-in
   * columns on conflict, same as the frontend original, so re-checking-in
   * doesn't clobber an existing check-out for the day. */
  async checkIn(
    authUid: string,
    user: { id: string; name: string },
    geo: GeoFix | null,
    label: string | null,
    markedBy: string,
  ): Promise<void> {
    await this.db.withCaller(authUid, (client) =>
      client.query(
        `insert into attendance_records
           (firm_id, user_id, user_name, work_date, status, check_in_at,
            check_in_lat, check_in_lng, check_in_accuracy, check_in_label, marked_by, updated_at)
         values (current_firm_id(), $1, $2, current_date, 'present', now(), $3, $4, $5, $6, $7, now())
         on conflict (firm_id, user_id, work_date) do update set
           user_name = excluded.user_name,
           status = excluded.status,
           check_in_at = excluded.check_in_at,
           check_in_lat = excluded.check_in_lat,
           check_in_lng = excluded.check_in_lng,
           check_in_accuracy = excluded.check_in_accuracy,
           check_in_label = excluded.check_in_label,
           marked_by = excluded.marked_by,
           updated_at = excluded.updated_at`,
        [user.id, user.name, geo?.lat ?? null, geo?.lng ?? null, geo?.accuracy ?? null, label || null, markedBy],
      ),
    );
  }

  /** Owner create/correct a record (backfill). Upsert on (firm,user,date) —
   * touches a different column set than checkIn (adds check_out/notes,
   * drops geo), matching the frontend original's separate upsert exactly. */
  async saveManualAttendance(
    authUid: string,
    input: ManualAttendanceInput,
    markedBy: string,
  ): Promise<void> {
    await this.db.withCaller(authUid, (client) =>
      client.query(
        `insert into attendance_records
           (firm_id, user_id, user_name, work_date, status, check_in_at,
            check_out_at, check_in_label, check_out_label, notes, marked_by, updated_at)
         values (current_firm_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
         on conflict (firm_id, user_id, work_date) do update set
           user_name = excluded.user_name,
           status = excluded.status,
           check_in_at = excluded.check_in_at,
           check_out_at = excluded.check_out_at,
           check_in_label = excluded.check_in_label,
           check_out_label = excluded.check_out_label,
           notes = excluded.notes,
           marked_by = excluded.marked_by,
           updated_at = excluded.updated_at`,
        [
          input.user_id,
          input.user_name,
          input.work_date,
          input.status,
          input.check_in_at || null,
          input.check_out_at || null,
          input.check_in_label || null,
          input.check_out_label || null,
          input.notes || null,
          markedBy,
        ],
      ),
    );
  }
}
