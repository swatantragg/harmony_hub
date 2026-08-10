import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus, Check, Minus } from 'lucide-react';
import { api } from '../../lib/api';
import { Modal, Skeleton, useToast } from '../../components/ui';
import { date, initials, relative } from '../../lib/format';
import type { Role } from '../../lib/types';

interface UserRow {
  _id: string; name: string; email: string; role: Role; jobTitle: string;
  status: string; lastLoginAt: string | null; createdAt: string; permissions: string[];
}

const PERMISSION_LABELS: Record<string, string> = {
  'asset:read': 'See and search files',
  'asset:download': 'Download files',
  'asset:upload': 'Upload new files',
  'asset:edit': 'Edit details, tags and folders',
  'asset:rename': 'Rename files',
  'asset:delete': 'Move files to the bin',
  'asset:purge': 'Destroy files and their Drive revisions permanently',
  'asset:restore': 'Restore files from the Google Drive bin',
  'catalogue:edit': 'Create and edit artists and songs',
  'share:create': 'Create external share links',
  'share:revoke': 'Revoke share links',
  'admin:storage': 'See Drive space and health, and fix drift',
  'admin:activity': 'Read the activity log',
  'admin:users': 'Manage people and roles',
};

const ORDER = Object.keys(PERMISSION_LABELS);

export function Users() {
  const [adding, setAdding] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => api<{ data: UserRow[]; roles: Role[]; permissionMatrix: Record<Role, string[]> }>('/admin/users'),
  });

  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) => api(`/admin/users/${id}`, { method: 'PATCH', body: { role } }),
    onSuccess: () => {
      qc.invalidateQueries();
      toast({ kind: 'ok', title: 'Role updated', body: 'It applies to their next request — no sign-out needed.' });
    },
  });

  if (isLoading || !data) return <div className="page stack-3"><Skeleton h={32} w="30%" /><Skeleton h={260} /></div>;

  return (
    <div className="page stack-5">
      <div className="spread page-head" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="t-h1">People</h1>
          <p className="t-body" style={{ maxWidth: '62ch', marginTop: 6 }}>
            Who has an account and what each of them can do. Changing a role takes effect
            immediately — the server checks permissions on every single request.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setAdding(true)}><UserPlus size={15} /> Add someone</button>
      </div>

      <div className="panel" style={{ overflow: 'hidden' }}>
        <div className="table-scroll">
          <table className="tbl">
            <thead><tr><th>Person</th><th>Role</th><th>Last signed in</th><th>Added</th></tr></thead>
            <tbody>
              {data.data.map((u) => (
                <tr key={u._id} style={{ cursor: 'default' }}>
                  <td>
                    <div className="row-tight">
                      <span
                        style={{
                          width: 32, height: 32, borderRadius: 9, background: 'var(--indigo-soft)',
                          color: 'var(--indigo-deep)', display: 'flex', alignItems: 'center',
                          justifyContent: 'center', fontSize: 12, fontWeight: 700, flex: 'none',
                        }}
                      >
                        {initials(u.name)}
                      </span>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{u.name}</div>
                        <div className="t-small" style={{ fontSize: 11.5 }}>{u.email} · {u.jobTitle}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <select
                      className="select"
                      style={{ width: 'auto', paddingRight: 30 }}
                      value={u.role}
                      onChange={(e) => changeRole.mutate({ id: u._id, role: e.target.value })}
                      aria-label={`Role for ${u.name}`}
                    >
                      {data.roles.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </td>
                  <td className="t-small">{u.lastLoginAt ? relative(u.lastLoginAt) : 'never'}</td>
                  <td className="t-small">{date(u.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <section>
        <h2 className="t-h2" style={{ marginBottom: 6 }}>What each role can do</h2>
        <p className="t-body" style={{ marginBottom: 14, maxWidth: '60ch' }}>
          Buttons a role cannot use are never shown to them — so nobody discovers a permission
          boundary by being refused.
        </p>
        <div className="panel" style={{ overflowX: 'auto' }}>
          <div className="table-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ minWidth: 230 }}>Capability</th>
                  {data.roles.map((r) => <th key={r} style={{ textAlign: 'center' }}>{r}</th>)}
                </tr>
              </thead>
              <tbody>
                {ORDER.map((perm) => (
                  <tr key={perm} style={{ cursor: 'default' }}>
                    <td style={{ fontWeight: 500 }}>{PERMISSION_LABELS[perm]}</td>
                    {data.roles.map((r) => (
                      <td key={r} style={{ textAlign: 'center' }}>
                        {data.permissionMatrix[r]?.includes(perm)
                          ? <Check size={15} color="var(--ok)" />
                          : <Minus size={14} color="var(--line-2)" />}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {adding && <AddUserDialog roles={data.roles} onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddUserDialog({ roles, onClose }: { roles: Role[]; onClose: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [role, setRole] = useState<Role>('Viewer');
  const [password, setPassword] = useState('');
  const qc = useQueryClient();
  const toast = useToast();

  const create = useMutation({
    mutationFn: () => api('/admin/users', { method: 'POST', body: { name, email, jobTitle, role, password } }),
    onSuccess: () => {
      qc.invalidateQueries();
      toast({ kind: 'ok', title: 'Account created', body: `Send ${email} their starting password over a private channel — it is never emailed from here.` });
      onClose();
    },
    onError: (e: Error) => toast({ kind: 'danger', title: 'Could not create the account', body: e.message }),
  });

  return (
    <Modal
      title="Add someone"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!name || !email || password.length < 8 || create.isPending} onClick={() => create.mutate()}>Create account</button>
        </>
      }
    >
      <div className="stack-3">
        <div className="field">
          <label className="label">Full name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label className="label">Work email</label>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label className="label">Job title</label>
          <input className="input" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="e.g. Content Editor" />
        </div>
        <div className="field">
          <label className="label">Starting password</label>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" />
          <div className="hint">Hashed with bcrypt before it is stored. Hand it over in person or over a private channel.</div>
        </div>
        <div className="field">
          <label className="label">Role</label>
          <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {roles.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <div className="hint">Start narrow — you can widen it later in one click.</div>
        </div>
      </div>
    </Modal>
  );
}
