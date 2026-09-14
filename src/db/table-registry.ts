// The allowlist for the generic data layer (TableWriteService / DataController).
// Every table the /api/data/* endpoints may touch — and every column they may
// write — has to be listed here explicitly. Nothing is derived from
// information_schema at request time: table and column names end up
// interpolated into SQL (values stay parameterized), so this registry is the
// actual security boundary, not RLS alone.
//
// Extend this as each module gets its own migrated tables (Phase 5, item 2.6+).
// `pk` is always assumed to be `id` unless stated otherwise below.
export interface TableSpec {
  /** Columns a client may set on insert/update. */
  columns: Set<string>;
  /** Columns a client may filter on (updateWhere/deleteWhere match keys, and
   *  query-param lookups). Usually a subset of `columns` — always includes
   *  `firm_id` implicitly via RLS, never needs to be listed here for that. */
  filterable: Set<string>;
}

function spec(columns: string[], filterable: string[] = []): TableSpec {
  return {
    columns: new Set(columns),
    filterable: new Set([...columns, ...filterable]),
  };
}

// Leads module (Phase 5, item 2.6).
export const TABLE_REGISTRY: Record<string, TableSpec> = {
  crm_leads: spec([
    'id',
    'firm_id',
    'client_name',
    'client_email',
    'client_phone',
    'client_whatsapp',
    'client_company',
    'project_type',
    'project_location',
    'estimated_budget',
    'estimated_area',
    'project_requirements',
    'status',
    'source',
    'priority',
    'assigned_to',
    'inquiry_date',
    'expected_start_date',
    'last_contact_date',
    'next_follow_up',
    'converted_project_id',
    'lost_reason',
    'tags',
    'notes',
    'created_by',
    'created_at',
    'updated_at',
    'contact_id',
    'prev_status',
    'lost_reason_category',
  ]),
  crm_lead_interactions: spec(
    [
      'id',
      'firm_id',
      'lead_id',
      'type',
      'subject',
      'description',
      'outcome',
      'next_steps',
      'scheduled_at',
      'completed_at',
      'logged_by',
      'created_at',
      'channel',
      'direction',
      'contact_id',
      'external_id',
    ],
    ['lead_id'],
  ),
  crm_lead_quotations: spec(
    [
      'id',
      'firm_id',
      'lead_id',
      'quotation_number',
      'version',
      'estimated_cost',
      'design_fees',
      'supervision_fees',
      'other_charges',
      'total_amount',
      'scope_of_work',
      'inclusions',
      'exclusions',
      'terms_conditions',
      'validity_days',
      'status',
      'sent_at',
      'client_response',
      'created_by',
      'created_at',
      'updated_at',
    ],
    ['lead_id'],
  ),
};

// Tasks module (Phase 5, item 2.9). assignee_id/created_by_id/actor_id are
// plain text, not profiles FKs — the task system predates full Supabase auth
// for non-owner staff and intentionally accepts a client-supplied identity
// for these fields (unlike firm_id, which RLS still independently enforces).
TABLE_REGISTRY.tasks = spec(
  [
    'id',
    'firm_id',
    'title',
    'description',
    'assignee_id',
    'assignee_name',
    'created_by_id',
    'created_by_name',
    'project_id',
    'project_name',
    'status',
    'priority',
    'start_date',
    'due_date',
    'reminder_at',
    'repeat',
    'tags',
    'notes',
    'attachments',
    'list_id',
    'link_type',
    'link_id',
    'link_label',
    'is_followup',
    'progress',
    'order_index',
    'archived_at',
    'created_at',
    'updated_at',
    'completed_at',
  ],
);
TABLE_REGISTRY.task_lists = spec([
  'id',
  'firm_id',
  'name',
  'color',
  'icon',
  'order_index',
  'created_by',
  'created_at',
]);
TABLE_REGISTRY.task_subtasks = spec([
  'id',
  'firm_id',
  'task_id',
  'title',
  'done',
  'order_index',
  'created_at',
]);
TABLE_REGISTRY.task_activity = spec([
  'id',
  'firm_id',
  'task_id',
  'actor_id',
  'actor_name',
  'kind',
  'detail',
  'created_at',
]);
// task_assign_privileges is NOT registered here — setAssignPrivilege needs
// upsert-on-conflict(firm_id,user_id) semantics the generic writer doesn't
// have, so it's served by two small dedicated endpoints in src/tasks/ instead.

// Attendance module (Phase 5, item 2.10). Only the columns actually written
// through this generic layer are listed — checkIn/saveManualAttendance are
// upserts (not supported here) and live in src/attendance/ instead.
TABLE_REGISTRY.attendance_records = spec([
  'id',
  'firm_id',
  'check_out_at',
  'check_out_lat',
  'check_out_lng',
  'check_out_accuracy',
  'check_out_label',
  'updated_at',
]);

// Marketing module (Phase 5, item 2.10). Only the columns setAccountStatus/
// setSyncInterval actually write — every read and the sync-run insert go
// through src/marketing/ instead (multi-table assembly / two-write transaction).
TABLE_REGISTRY.crm_ad_accounts = spec([
  'id',
  'firm_id',
  'status',
  'sync_interval_minutes',
  'updated_at',
]);

export function getTableSpec(table: string): TableSpec {
  const spec = TABLE_REGISTRY[table];
  if (!spec) {
    throw new Error(`table "${table}" is not in the data-layer registry`);
  }
  return spec;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** Throws if `name` isn't a safe bare SQL identifier. Used before any
 * interpolation of a table/column name into a query string. */
export function assertIdent(name: string): string {
  if (!IDENT.test(name)) throw new Error(`unsafe identifier: "${name}"`);
  return name;
}
