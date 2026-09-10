-- ─────────────────────────────────────────────────────────────
-- 28_boq_module_catalog_rebuild
-- The original demo module_templates/module_rules (and the global catalog
-- they referenced by name) were wiped in a prior reset, leaving only a
-- broken 1-template/1-rule stub. The catalog was independently rebuilt
-- since (firm-scoped products/SKUs/rate_cards/labour_activities) by later
-- "Catalog & Rates" admin work. This migration authors fresh
-- module_templates + module_rules wired to the CURRENT live catalog (by
-- explicit product_id / labour_activity_id), covering every category the
-- present catalog can fully support, then retires the broken stub.
-- ─────────────────────────────────────────────────────────────

-- 1) module templates ---------------------------------------------------------
insert into module_templates (id, firm_id, code, name, category, description, param_schema, derived_vars) values
('aa0a0000-0000-4000-8000-000000000001', null, 'KITCHEN_MODULAR','Modular Kitchen','kitchen_modular',
 'Base + wall + optional loft units, carcass + shutters + hardware + install',
 '{"base_run_mm":{"type":"number","default":3000,"min":600},"wall_run_mm":{"type":"number","default":2400,"min":0},"loft":{"type":"boolean","default":false},"loft_run_mm":{"type":"number","default":1200,"min":0},"drawers":{"type":"number","default":4,"min":0}}',
 '[{"name":"base_rft","formula":"base_run_mm/304.8"},{"name":"wall_rft","formula":"wall_run_mm/304.8"},{"name":"loft_rft","formula":"loft ? loft_run_mm/304.8 : 0"},{"name":"carcass_sqft","formula":"base_rft*11 + wall_rft*7.5 + loft_rft*6.5"},{"name":"backing_sqft","formula":"(base_rft+wall_rft+loft_rft)*2.4"},{"name":"front_sqft","formula":"base_rft*2 + wall_rft*2.5 + loft_rft*1.8"},{"name":"shutter_count","formula":"round((base_rft+wall_rft)/1.5)"},{"name":"handle_rft","formula":"shutter_count*1.3 + drawers*1.3"}]'),

('aa0a0000-0000-4000-8000-000000000002', null, 'WARDROBE','Wardrobe','wardrobe',
 'Hinged or sliding wardrobe, full-height carcass + shutters + hardware + install',
 '{"width_mm":{"type":"number","default":2400,"min":900},"height_mm":{"type":"number","default":2400,"min":1800},"depth_mm":{"type":"number","default":600,"min":450},"type":{"type":"enum","values":["hinged","sliding"],"default":"hinged"},"drawers":{"type":"number","default":2,"min":0},"loft":{"type":"boolean","default":true}}',
 '[{"name":"width_ft","formula":"width_mm/304.8"},{"name":"height_ft","formula":"height_mm/304.8"},{"name":"face_sqft","formula":"width_ft*height_ft"},{"name":"carcass_sqft","formula":"face_sqft*1.9"},{"name":"shutter_count","formula":"type==\"sliding\" ? 2 : round(width_ft/1.5)"},{"name":"hinges_total","formula":"type==\"sliding\" ? 0 : shutter_count*(height_mm<=1500?3:4)"}]'),

('aa0a0000-0000-4000-8000-000000000003', null, 'TV_UNIT','TV Unit','tv_unit',
 'Wall-mounted / floor TV unit with paneling and storage',
 '{"width_mm":{"type":"number","default":2400,"min":900},"height_mm":{"type":"number","default":2700,"min":1800},"drawers":{"type":"number","default":2,"min":0}}',
 '[{"name":"width_ft","formula":"width_mm/304.8"},{"name":"height_ft","formula":"height_mm/304.8"},{"name":"panel_sqft","formula":"width_ft*height_ft"},{"name":"storage_rft","formula":"width_ft"},{"name":"shutter_count","formula":"round(storage_rft/1.5)"}]'),

('aa0a0000-0000-4000-8000-000000000004', null, 'WALL_PANELING','Wall Paneling','wall_paneling',
 'Decorative wall paneling by area',
 '{"area_sqft":{"type":"number","default":80,"min":1}}',
 '[{"name":"area","formula":"area_sqft"},{"name":"ply_sqft","formula":"area_sqft*1.05"}]'),

('aa0a0000-0000-4000-8000-000000000005', null, 'FLOORING','Flooring','flooring',
 'Tile / marble / granite flooring by area',
 '{"area_sqft":{"type":"number","default":150,"min":1},"material":{"type":"enum","values":["vitrified","marble","granite","outdoor_antiskid"],"default":"vitrified"}}',
 '[{"name":"area","formula":"area_sqft"}]'),

('aa0a0000-0000-4000-8000-000000000006', null, 'ELECTRICAL','Electrical Works','electrical',
 'Points, wiring, DB and light fittings by point count',
 '{"points":{"type":"number","default":20,"min":1},"wire_per_point_m":{"type":"number","default":8},"mcb_count":{"type":"number","default":4,"min":1},"lights":{"type":"number","default":6,"min":0}}',
 '[{"name":"wire_m","formula":"points*wire_per_point_m"},{"name":"wire_rft","formula":"wire_m*3.281"}]'),

('aa0a0000-0000-4000-8000-000000000007', null, 'PAINTING','Painting','painting',
 'Interior / exterior painting by wall area',
 '{"wall_area_sqft":{"type":"number","default":400,"min":1},"coats":{"type":"number","default":2,"min":1},"type":{"type":"enum","values":["interior","exterior"],"default":"interior"}}',
 '[{"name":"area","formula":"wall_area_sqft"},{"name":"paint_litres","formula":"area*coats/120"},{"name":"primer_litres","formula":"area/140"}]'),

('aa0a0000-0000-4000-8000-000000000008', null, 'PLUMBING','Plumbing Works','plumbing',
 'Supply piping, stop cocks, floor traps and fixtures',
 '{"pipe_run_rft":{"type":"number","default":40,"min":1},"wash_basins":{"type":"number","default":1,"min":0},"stop_cocks":{"type":"number","default":2,"min":0},"floor_traps":{"type":"number","default":1,"min":0}}',
 '[]');

-- 2) module rules, referencing the live catalog/labour by explicit id --------
-- [Phase 5 overlay] module_rules insert filtered to FK targets that exist.
-- The ~23 f1000000-* catalog_products / ~6 c1000000-* labour_activities this
-- migration references were entered via the app UI and never captured as a
-- migration; production has none of them. Rows whose product_id /
-- labour_activity_id is absent are skipped so the tree still loads; the full
-- module catalogue arrives with the Phase 6 data import from staging.
insert into module_rules (template_id, seq, output_kind, product_id, labour_activity_id, label, condition, qty_formula, uom)
select v.template_id::uuid, v.seq::int, v.output_kind::module_output_kind,
       v.product_id::uuid, v.labour_activity_id::uuid,
       v.label, v.condition, v.qty_formula, v.uom::uom
from (values
-- KITCHEN
('aa0a0000-0000-4000-8000-000000000001',1,'material','f1000000-0000-4000-8000-000000000001',null,'Carcass (18mm ply)',null,'carcass_sqft/32','sheet'),
('aa0a0000-0000-4000-8000-000000000001',2,'material','f1000000-0000-4000-8000-000000000004',null,'Back panels (8mm HDF)',null,'backing_sqft/32','sheet'),
('aa0a0000-0000-4000-8000-000000000001',3,'material','f1000000-0000-4000-8000-000000000002',null,'Shutter laminate finish',null,'front_sqft/32','sheet'),
('aa0a0000-0000-4000-8000-000000000001',4,'hardware','f1000000-0000-4000-8000-000000000015',null,'Soft-close hinges',null,'shutter_count*2','nos'),
('aa0a0000-0000-4000-8000-000000000001',5,'hardware','f1000000-0000-4000-8000-000000000016',null,'Drawer channels',null,'drawers','pair'),
('aa0a0000-0000-4000-8000-000000000001',6,'hardware','f1000000-0000-4000-8000-000000000017',null,'Cabinet handles',null,'handle_rft','rft'),
('aa0a0000-0000-4000-8000-000000000001',7,'labour',null,'c1000000-0000-4000-8000-000000000014','Cabinet installation',null,'front_sqft','sqft'),
-- WARDROBE
('aa0a0000-0000-4000-8000-000000000002',1,'material','f1000000-0000-4000-8000-000000000001',null,'Carcass (18mm ply)',null,'carcass_sqft/32','sheet'),
('aa0a0000-0000-4000-8000-000000000002',2,'material','f1000000-0000-4000-8000-000000000004',null,'Back panel (8mm HDF)',null,'face_sqft/32','sheet'),
('aa0a0000-0000-4000-8000-000000000002',3,'material','f1000000-0000-4000-8000-000000000002',null,'Shutter laminate finish','type=="hinged"','face_sqft/32','sheet'),
('aa0a0000-0000-4000-8000-000000000002',4,'material','f1000000-0000-4000-8000-000000000028',null,'Sliding shutter glass panel','type=="sliding"','face_sqft*0.5','sqft'),
('aa0a0000-0000-4000-8000-000000000002',5,'material','f1000000-0000-4000-8000-000000000002',null,'Sliding shutter laminate (balance)','type=="sliding"','(face_sqft*0.5)/32','sheet'),
('aa0a0000-0000-4000-8000-000000000002',6,'hardware','f1000000-0000-4000-8000-000000000015',null,'Soft-close hinges','type=="hinged"','hinges_total','nos'),
('aa0a0000-0000-4000-8000-000000000002',7,'hardware','f1000000-0000-4000-8000-000000000016',null,'Drawer channels',null,'drawers','pair'),
('aa0a0000-0000-4000-8000-000000000002',8,'hardware','f1000000-0000-4000-8000-000000000017',null,'Wardrobe handles',null,'shutter_count + drawers','rft'),
('aa0a0000-0000-4000-8000-000000000002',9,'labour',null,'c1000000-0000-4000-8000-000000000013','Wardrobe installation',null,'face_sqft','sqft'),
-- TV UNIT
('aa0a0000-0000-4000-8000-000000000003',1,'material','f1000000-0000-4000-8000-000000000001',null,'Storage carcass + panel substrate',null,'(storage_rft*9 + panel_sqft*1.05)/32','sheet'),
('aa0a0000-0000-4000-8000-000000000003',2,'material','f1000000-0000-4000-8000-000000000004',null,'Back panel (8mm HDF)',null,'(storage_rft*2.4)/32','sheet'),
('aa0a0000-0000-4000-8000-000000000003',3,'material','f1000000-0000-4000-8000-000000000002',null,'Laminate finish',null,'(panel_sqft + storage_rft*4)/32','sheet'),
('aa0a0000-0000-4000-8000-000000000003',4,'hardware','f1000000-0000-4000-8000-000000000015',null,'Hinges',null,'shutter_count*2','nos'),
('aa0a0000-0000-4000-8000-000000000003',5,'hardware','f1000000-0000-4000-8000-000000000016',null,'Drawer channels',null,'drawers','pair'),
('aa0a0000-0000-4000-8000-000000000003',6,'hardware','f1000000-0000-4000-8000-000000000017',null,'Handles',null,'shutter_count + drawers','rft'),
('aa0a0000-0000-4000-8000-000000000003',7,'labour',null,'c1000000-0000-4000-8000-000000000013','Carpentry installation',null,'panel_sqft','sqft'),
-- WALL PANELING
('aa0a0000-0000-4000-8000-000000000004',1,'material','f1000000-0000-4000-8000-000000000003',null,'Paneling substrate (12mm MDF)',null,'ply_sqft/32','sheet'),
('aa0a0000-0000-4000-8000-000000000004',2,'material','f1000000-0000-4000-8000-000000000002',null,'Laminate finish',null,'area/32','sheet'),
('aa0a0000-0000-4000-8000-000000000004',3,'labour',null,'c1000000-0000-4000-8000-000000000013','Carpentry installation',null,'area','sqft'),
-- FLOORING
('aa0a0000-0000-4000-8000-000000000005',1,'material','f1000000-0000-4000-8000-000000000006',null,'Vitrified floor tile','material=="vitrified"','area','sqft'),
('aa0a0000-0000-4000-8000-000000000005',2,'material','f1000000-0000-4000-8000-000000000008',null,'Italian marble','material=="marble"','area','sqft'),
('aa0a0000-0000-4000-8000-000000000005',3,'material','f1000000-0000-4000-8000-000000000009',null,'Black granite','material=="granite"','area','sqft'),
('aa0a0000-0000-4000-8000-000000000005',4,'material','f1000000-0000-4000-8000-000000000010',null,'Anti-skid outdoor tile','material=="outdoor_antiskid"','area','sqft'),
('aa0a0000-0000-4000-8000-000000000005',5,'labour',null,'c1000000-0000-4000-8000-000000000004','Tile / stone laying',null,'area','sqft'),
-- ELECTRICAL
('aa0a0000-0000-4000-8000-000000000006',1,'material','f1000000-0000-4000-8000-000000000019',null,'Switch / socket points',null,'points','nos'),
('aa0a0000-0000-4000-8000-000000000006',2,'material','f1000000-0000-4000-8000-000000000021',null,'Wiring',null,'wire_rft','rft'),
('aa0a0000-0000-4000-8000-000000000006',3,'material','f1000000-0000-4000-8000-000000000022',null,'MCBs / DB',null,'mcb_count','nos'),
('aa0a0000-0000-4000-8000-000000000006',4,'material','f1000000-0000-4000-8000-000000000020',null,'Ceiling lights',null,'lights','nos'),
('aa0a0000-0000-4000-8000-000000000006',5,'labour',null,'c1000000-0000-4000-8000-000000000008','Point wiring labour',null,'points','point'),
-- PAINTING
('aa0a0000-0000-4000-8000-000000000007',1,'material','f1000000-0000-4000-8000-000000000011',null,'Interior emulsion paint','type=="interior"','paint_litres','litre'),
('aa0a0000-0000-4000-8000-000000000007',2,'material','f1000000-0000-4000-8000-000000000012',null,'Exterior weatherproof paint','type=="exterior"','paint_litres','litre'),
('aa0a0000-0000-4000-8000-000000000007',3,'material','f1000000-0000-4000-8000-000000000013',null,'Wall primer / sealer',null,'primer_litres','litre'),
('aa0a0000-0000-4000-8000-000000000007',4,'labour',null,'c1000000-0000-4000-8000-000000000011','Painting labour',null,'area','sqft'),
-- PLUMBING
('aa0a0000-0000-4000-8000-000000000008',1,'material','f1000000-0000-4000-8000-000000000023',null,'Supply piping',null,'pipe_run_rft','rft'),
('aa0a0000-0000-4000-8000-000000000008',2,'material','f1000000-0000-4000-8000-000000000024',null,'Stop cocks',null,'stop_cocks','nos'),
('aa0a0000-0000-4000-8000-000000000008',3,'material','f1000000-0000-4000-8000-000000000025',null,'Floor traps',null,'floor_traps','nos'),
('aa0a0000-0000-4000-8000-000000000008',4,'material','f1000000-0000-4000-8000-000000000026',null,'Wash basin (table-top)',null,'wash_basins','nos'),
('aa0a0000-0000-4000-8000-000000000008',5,'labour',null,'c1000000-0000-4000-8000-000000000010','Fixture installation',null,'wash_basins + stop_cocks + floor_traps','nos')
) as v(template_id, seq, output_kind, product_id, labour_activity_id, label, condition, qty_formula, uom)
where (v.product_id is null
       or exists (select 1 from catalog_products cp where cp.id = v.product_id::uuid))
  and (v.labour_activity_id is null
       or exists (select 1 from labour_activities la where la.id = v.labour_activity_id::uuid));

-- 3) repoint the existing demo module_instance off the broken stub, then retire it
update module_instances set template_id = 'aa0a0000-0000-4000-8000-000000000002'
 where template_id = 'd1000000-0000-4000-8000-000000000001';
delete from module_rules where template_id = 'd1000000-0000-4000-8000-000000000001';
delete from module_templates where id = 'd1000000-0000-4000-8000-000000000001';
