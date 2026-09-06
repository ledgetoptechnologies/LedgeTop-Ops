/**
 * Fixed, parameterized native portal scope proof. Parameters are targets JSON,
 * workspace id, generation id, relation mode, and the recursive row limit.
 * Both Workers use this exact query when deciding whether a Project Alpha
 * project remains in an identity's current native scope.
 */
export const NATIVE_PORTAL_TARGET_SCOPES_SQL=`WITH RECURSIVE
    requested(target_type,target_id) AS (
      SELECT DISTINCT json_extract(value,'$.scopeType'),json_extract(value,'$.publicId') FROM json_each(?1)
    ), current_generation AS (
      SELECT cp.workspace_id,cp.active_generation_id generation_id FROM portal_v2_directory_checkpoints cp
      JOIN portal_v2_directory_generations g ON g.id=cp.active_generation_id AND g.workspace_id=cp.workspace_id AND g.status='active' AND g.complete=1
      WHERE cp.workspace_id=?2 AND cp.active_generation_id=?3
        AND (?4=1 OR NOT EXISTS(SELECT 1 FROM portal_v2_directory_generation_contracts c
          WHERE c.workspace_id=cp.workspace_id AND c.generation_id=cp.active_generation_id AND c.schema_version=3))
    ), roots AS (
      SELECT r.target_type,r.target_id,e.entity_type,e.public_id,e.parent_public_id,e.source_version,
        substr(e.display_name,1,500) display_name,b.source_version binding_version
      FROM requested r JOIN current_generation g
      LEFT JOIN portal_v2_folder_bindings b ON r.target_type='folder' AND b.id=r.target_id AND b.workspace_id=g.workspace_id
        AND b.status='active' AND b.revoked_at IS NULL
      JOIN portal_v2_directory_entities e ON e.workspace_id=g.workspace_id AND e.generation_id=g.generation_id AND e.active=1
        AND e.entity_type=CASE WHEN r.target_type='folder' THEN b.owner_scope_type ELSE r.target_type END
        AND e.public_id=CASE WHEN r.target_type='folder' THEN b.owner_public_id ELSE r.target_id END
        AND (r.target_type<>'folder' OR e.source_version=b.source_version)
    ), lineage(target_type,target_id,entity_type,public_id,parent_public_id,source_version,depth) AS (
      SELECT target_type,target_id,entity_type,public_id,parent_public_id,source_version,0 FROM roots
      UNION
      SELECT l.target_type,l.target_id,p.entity_type,p.public_id,p.parent_public_id,p.source_version,l.depth+1
      FROM lineage l JOIN current_generation g
      JOIN portal_v2_directory_entities p ON p.workspace_id=g.workspace_id AND p.generation_id=g.generation_id AND p.active=1
        AND p.public_id=l.parent_public_id WHERE ?4=0 AND l.depth<8
        AND (SELECT count(*) FROM portal_v2_directory_entities same_parent WHERE same_parent.workspace_id=g.workspace_id
          AND same_parent.generation_id=g.generation_id AND same_parent.public_id=l.parent_public_id AND same_parent.active=1)=1
      UNION
      SELECT l.target_type,l.target_id,p.entity_type,p.public_id,p.parent_public_id,p.source_version,l.depth+1
      FROM lineage l JOIN current_generation g
      JOIN portal_v2_directory_relations edge ON edge.workspace_id=g.workspace_id AND edge.generation_id=g.generation_id AND edge.active=1
        AND edge.to_type=l.entity_type AND edge.to_public_id=l.public_id
      JOIN portal_v2_directory_entities p ON p.workspace_id=g.workspace_id AND p.generation_id=g.generation_id AND p.active=1
        AND p.entity_type=edge.from_type AND p.public_id=edge.from_public_id WHERE ?4=1 AND l.depth<12
      LIMIT ?5
    ) SELECT l.*,r.display_name,r.binding_version,
      CASE WHEN l.entity_type<>'project' OR ?4=0 THEN 1
        WHEN NOT EXISTS(SELECT 1 FROM portal_v2_project_lifecycle lifecycle
          WHERE lifecycle.workspace_id=?2 AND lifecycle.generation_id=?3 AND lifecycle.project_public_id=l.public_id
            AND (lifecycle.lifecycle_status='active' OR (lifecycle.lifecycle_status='completed' AND datetime(lifecycle.completed_at) IS NOT NULL))) THEN -1
        WHEN EXISTS(SELECT 1 FROM portal_v2_project_lifecycle lifecycle
          WHERE lifecycle.workspace_id=?2 AND lifecycle.generation_id=?3 AND lifecycle.project_public_id=l.public_id
          AND (lifecycle.lifecycle_status='active' OR datetime(lifecycle.completed_at,'+30 days')>datetime('now'))) THEN 1 ELSE 0 END retained
      FROM lineage l JOIN roots r ON r.target_type=l.target_type AND r.target_id=l.target_id
      ORDER BY l.target_type,l.target_id,l.depth,l.entity_type,l.public_id`;
