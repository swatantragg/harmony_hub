import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus, KeyRound } from 'lucide-react';
import { api } from '../../lib/api';
import { Modal, Skeleton, useToast } from '../../components/ui';
import { date, initials, relative } from '../../lib/format';
import type { Role } from '../../lib/types';

interface UserRow {
  _id: string; name: string; email: string; role: Role;
  status: string; lastLoginAt: string | null; createdAt: string; permissions: string[];
  mustChangePassword: boolean;
}

interface UsersResponse {
  data: UserRow[];
  roles: Role[];
  permissionMatrix: Record<Role, string[]>;
  minPasswordLength: number;
}

export function Users() {
  const [adding, setAdding] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => api<UsersResponse>('/admin/users'),
  });

  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) => api(`/admin/users/${id}`, { method: 'PATCH', body: { role } }),
    onSuccess: () => {
      qc.invalidateQueries();
      toast({ kind: 'ok', title: 'Role updated', body: 'It applies to their next request — no sign-out needed.' });
    },
    onError: (e: Error) => toast({ kind: 'danger', title: 'Could not change the role', body: e.message }),
  });

  if (isLoading || !data) return <div className="page stack-3"><Skeleton h={32} w="30%" /><Skeleton h={260} /></div>;

  return (
    <div className="page stack-5">
      <div className="spread page-head" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="t-h1">People</h1>
          <p className="t-body" style={{ maxWidth: '62ch', marginTop: 6 }}>
            Who has an account. There are two roles, and one difference between them: an Admin
            can add people, a User cannot. Everything else in the product is open to both.
            Changing a role takes effect immediately — the server checks permissions on every
            single request.
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
                          justifyContent: 'center', fontSize: 14.5, fontWeight: 700, flex: 'none',
                        }}
                      >
                        {initials(u.name)}
                      </span>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 15.5 }}>{u.name}</div>
                        <div className="t-small" style={{ fontSize: 14 }}>{u.email}</div>
                        {/* An account that has not been picked up yet looks identical to
                            one in daily use unless the page says so. */}
                        {u.mustChangePassword && (
                          <div className="t-small row-tight" style={{ fontSize: 13.5, marginTop: 3, color: 'var(--mismatch-ink)' }}>
                            <KeyRound size={11} /> has not set their own password yet
                          </div>
                        )}
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

      {adding && (
        <AddUserDialog
          roles={data.roles}
          minLength={data.minPasswordLength ?? 8}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

const ROLE_HINT: Record<string, string> = {
  Admin: 'Everything, including adding and removing people.',
  User: 'Everything except adding people — uploads, edits, deletions, shares, storage health.',
};

function AddUserDialog({
  roles, minLength, onClose,
}: { roles: Role[]; minLength: number; onClose: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('User');
  const [password, setPassword] = useState('');
  const qc = useQueryClient();
  const toast = useToast();

  const create = useMutation({
    mutationFn: () => api('/admin/users', { method: 'POST', body: { name, email, role, password } }),
    onSuccess: () => {
      qc.invalidateQueries();
      toast({
        kind: 'ok',
        title: 'Account created',
        body: `Give ${email} this starting password over a private channel. It works once — they will be asked to choose their own before they can use anything.`,
      });
      onClose();
    },
    onError: (e: Error) => toast({ kind: 'danger', title: 'Could not create the account', body: e.message }),
  });

  const ready = name.trim() && email.trim() && password.length >= minLength;

  return (
    <Modal
      title="Add someone"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!ready || create.isPending} onClick={() => create.mutate()}>Create account</button>
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
          <div className="hint">This is what they sign in with.</div>
        </div>
        <div className="field">
          <label className="label">Starting password</label>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={`At least ${minLength} characters`}
          />
          <div className="hint">
            Hashed with bcrypt before it is stored, and never emailed from here — hand it over in
            person or over a private channel. It is good for one sign-in: they are required to set
            a password of their own before anything else opens.
          </div>
        </div>
        <div className="field">
          <label className="label">Role</label>
          <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {roles.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <div className="hint">{ROLE_HINT[role] ?? ''}</div>
        </div>
      </div>
    </Modal>
  );
}
