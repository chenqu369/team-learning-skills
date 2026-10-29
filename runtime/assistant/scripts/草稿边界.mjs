import {assertBeijingIso} from './北京时间.mjs';
// This workflow cannot publish or approve, even when given a publish-shaped command.
export function enforceDraftOnly(method, pathname, body) {
  if (method === 'GET') {
    const readOnly=/^\/api\/v1\/(?:users\/me|admin\/projects(?:\/\d+(?:\/tasks)?)?|projects(?:\/\d+)?|tasks(?:\/\d+|\/by-project\/\d+)?|certificate-templates)$/.test(pathname);
    if(!readOnly&&!/^\/api\/v1\/admin\/tasks\/\d+\/contact-qr$/.test(pathname))throw Error('DRAFT_ONLY: unrecognized read route, including action routes disguised as GET');
    return body;
  }
  const create = method === 'POST' && (/^\/api\/v1\/admin\/projects$/.test(pathname) || /^\/api\/v1\/admin\/projects\/\d+\/tasks$/.test(pathname));
  const edit = method === 'PUT' && /^\/api\/v1\/admin\/(projects|tasks)\/\d+$/.test(pathname);
  const withdraw = method === 'PATCH' && /^\/api\/v1\/admin\/(projects|tasks)\/\d+\/status$/.test(pathname);
  if (!create && !edit && !withdraw) throw Error('DRAFT_ONLY: operation is outside the draft workflow');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('DRAFT_ONLY: expected an object payload');
  const projectFields=new Set(['name','description','content_markdown','cover_image','contact_qr_image_url','tags','project_type','access_scope','assistant_category','assistant_period','certificate_scene','certificate_template_ids','github_url','status']);
  const taskFields=new Set(['title','description','subtitle','requirement','assistant_identity','task_type','difficulty','base_points','capacity','claim_mode','deadline','submit_types','post_submit_content','post_submit_image_url','domain','work_type','preview_image_url','banner_image_url','contact_qr_image_url','form_fields','tags','status']);
  const isTask=/\/tasks(?:\/\d+)?$/.test(pathname);
  const allowed=withdraw?new Set(['status']):isTask?taskFields:projectFields;
  for(const key of Object.keys(body))if(!allowed.has(key))throw Error('DRAFT_ONLY: unrecognized field '+key);
  if(body.form_fields!==undefined){
    if(!Array.isArray(body.form_fields))throw Error('DRAFT_ONLY: form_fields must be an array');
    const fields=new Set(['id','label','field_type','options','is_required','sort_order']);
    for(const field of body.form_fields){
      if(!field||typeof field!=='object'||Array.isArray(field))throw Error('DRAFT_ONLY: invalid form field');
      for(const key of Object.keys(field))if(!fields.has(key))throw Error('DRAFT_ONLY: unknown form field property '+key);
    }
  }
  function inspect(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'status' && entry !== 'draft') throw Error('DRAFT_ONLY: publishing and non-draft statuses are forbidden');
      if (key === 'review_status' || /^(approve|approved|publish|published|auto_publish|auto_approve)$/.test(key)) throw Error('DRAFT_ONLY: approval and publish fields are forbidden');
      inspect(entry);
    }
  }
  inspect(body);
  if (withdraw && (body.status !== 'draft' || Object.keys(body).length !== 1)) throw Error('DRAFT_ONLY: status endpoint permits only withdrawal to draft');
  for(const key of ['deadline','end_time']) if(body[key]!=null) assertBeijingIso(body[key]);
  return {...body, status: 'draft'};
}

