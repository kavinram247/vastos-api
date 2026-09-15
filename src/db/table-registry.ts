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

// Purchase Management module (Phase 5, item 2.12). Only project_stock (plain
// CRUD, no generated fields, no FK needing a server-side resolution) goes
// through this layer. `vendors` looked like the same shape (list/save/
// delete, no generated number) but its `created_by` is a uuid FK to
// `profiles.id` — a different id space than the `userId` (crm_profiles.id,
// text) the frontend actually holds — so it needs the same server-side
// `select id from profiles where auth_uid = $1` resolution BOQ's own,
// already-shipped vendor writes use (boq-vendor.service.ts); that can't be
// expressed by this generic, no-per-column-logic layer, so vendors stays
// bespoke in src/purchase/purchase-masters.service.ts instead. Purchase
// orders/requests/RFQs/work orders all need a server-computed document
// number (PO-2026-012 etc.) or multi-row child replace-on-save, so they're
// bespoke services too.
TABLE_REGISTRY.project_stock = spec([
  'id',
  'firm_id',
  'project_id',
  'material_id',
  'material_name',
  'uom',
  'current_stock',
  'reorder_level',
  'last_updated',
  'last_po_id',
  'updated_at',
]);

// Core CRM DataStore tables (Phase 5, item 2.13). Until now only the three
// leads tables wrote through this layer: every other DataStore write in
// Vastos_ARC's crmApi.ts still went to Supabase while /api/firm/bootstrap read
// the same tables from the VPS, so anything created or edited there since the
// 11 Sep cutover landed in a database the app no longer reads. Full column
// lists, same as crm_leads — the store sends whole rows on insert and
// arbitrary patches on update. RLS is firm_id = current_firm_id() on every one
// of these; crm_profiles additionally keeps guard_crm_profile_privileges
// (role_id/firm_id changes are admin-only, never on yourself).
//
// crm_roles / crm_role_permissions are deliberately NOT registered: RLS gives
// `authenticated` a SELECT policy only, so every write to them is refused on
// both databases — registering them would expose nothing but that refusal.
TABLE_REGISTRY.crm_profiles = spec([
  'id', 'firm_id', 'email', 'full_name', 'role', 'phone', 'avatar_url', 'created_at', 'role_id',
]);
TABLE_REGISTRY.crm_projects = spec([
  'id', 'firm_id', 'name', 'client_id', 'project_value', 'start_date', 'estimated_end_date',
  'actual_end_date', 'status', 'description', 'address', 'created_at', 'updated_at',
]);
TABLE_REGISTRY.crm_project_assignments = spec([
  'id', 'firm_id', 'project_id', 'user_id', 'role', 'assigned_at',
]);
TABLE_REGISTRY.crm_milestones = spec([
  'id', 'firm_id', 'project_id', 'name', 'description', 'planned_start', 'planned_end',
  'actual_start', 'actual_end', 'status', 'delay_reason', 'order_index', 'created_at',
]);
TABLE_REGISTRY.crm_site_updates = spec([
  'id', 'firm_id', 'project_id', 'posted_by', 'date', 'note', 'photo_urls', 'created_at',
]);
TABLE_REGISTRY.crm_payment_plans = spec([
  'id', 'firm_id', 'project_id', 'total_amount', 'split_count', 'client_signed_off',
  'signed_off_at', 'created_at',
]);
TABLE_REGISTRY.crm_payment_splits = spec([
  'id', 'firm_id', 'payment_plan_id', 'project_id', 'split_number', 'amount', 'trigger_type',
  'trigger_date', 'trigger_milestone_id', 'status', 'gst_rate', 'gst_amount', 'total_with_gst',
  'created_at',
]);
TABLE_REGISTRY.crm_payments_received = spec([
  'id', 'firm_id', 'payment_split_id', 'project_id', 'amount', 'received_date', 'mode',
  'reference', 'marked_by', 'created_at',
]);
TABLE_REGISTRY.crm_cost_entries = spec([
  'id', 'firm_id', 'project_id', 'category', 'description', 'amount', 'date', 'vendor_name',
  'receipt_url', 'created_by', 'created_at',
]);
TABLE_REGISTRY.crm_comments = spec([
  'id', 'firm_id', 'project_id', 'author_id', 'content', 'is_pinned', 'parent_id', 'created_at',
  'updated_at',
]);
TABLE_REGISTRY.crm_notifications = spec([
  'id', 'firm_id', 'user_id', 'title', 'message', 'type', 'read', 'link', 'created_at',
]);
TABLE_REGISTRY.crm_activity_log = spec([
  'id', 'firm_id', 'user_id', 'action', 'action_label', 'module', 'entity_type', 'entity_id',
  'entity_name', 'previous_value', 'updated_value', 'details', 'remarks', 'created_at',
]);
TABLE_REGISTRY.crm_project_documents = spec([
  'id', 'firm_id', 'project_id', 'name', 'file_type', 'file_url', 'file_size', 'category',
  'uploaded_by', 'visible_to_client', 'version', 'description', 'created_at',
]);
TABLE_REGISTRY.crm_project_vendors = spec([
  'id', 'firm_id', 'project_id', 'company_name', 'contact_person', 'phone', 'email', 'gstin',
  'category', 'scope_of_work', 'contract_value', 'status', 'start_date', 'end_date', 'rating',
  'notes', 'added_by', 'created_at', 'updated_at',
]);
TABLE_REGISTRY.crm_contacts = spec([
  'id', 'firm_id', 'full_name', 'email', 'phone', 'company', 'tags', 'notes', 'first_seen',
  'created_at',
]);
TABLE_REGISTRY.crm_pipeline_stages = spec([
  'id', 'firm_id', 'key', 'label', 'order_index', 'category', 'is_won', 'is_lost', 'color',
  'enabled', 'created_at',
]);
TABLE_REGISTRY.crm_feature_flags = spec(['id', 'firm_id', 'key', 'enabled', 'created_at']);
TABLE_REGISTRY.crm_comm_channels = spec([
  'id', 'firm_id', 'provider', 'category', 'display_name', 'status', 'config', 'connected_by',
  'connected_at', 'created_at',
]);
TABLE_REGISTRY.crm_dashboard_layouts = spec([
  'id', 'firm_id', 'user_id', 'module', 'name', 'is_default', 'scope', 'config', 'created_by',
  'created_at', 'updated_at',
]);

// Marketing attribution (Phase 5, item 2.13): attribution.ts's "Map to CRM"
// writes, the last Marketing writes still on Supabase after item 2.10. Only
// the columns it actually sets.
TABLE_REGISTRY.crm_ad_leads = spec(['id', 'firm_id', 'crm_lead_id', 'contact_id', 'status']);
TABLE_REGISTRY.crm_marketing_attribution = spec(
  ['id', 'firm_id', 'lead_id', 'stage', 'updated_at'],
  ['ad_lead_id'],
);

/** The `jsonb` columns among the registered ones. node-postgres sends a JS
 * array as a Postgres array literal (`[]` → `'{}'`, `[{…}]` → an unparseable
 * `{"{…}"}`), so a jsonb value has to be JSON.stringify'd and cast instead —
 * see TableWriterService. Found via tasks.attachments: since item 2.9 every
 * new task stored `{}` (an object the UI then .map()s) and adding an
 * attachment failed outright. text[] columns (tags, photo_urls) are real
 * Postgres arrays and must NOT be listed here. */
export const JSONB_COLUMNS: Record<string, ReadonlySet<string>> = {
  tasks: new Set(['attachments']),
  crm_comm_channels: new Set(['config']),
  crm_dashboard_layouts: new Set(['config']),
};

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
