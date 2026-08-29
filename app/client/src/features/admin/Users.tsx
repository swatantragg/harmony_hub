import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus, KeyRound, LogIn, UserMinus, UserCheck, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { ConfirmDialog, Modal, PasswordInput, Skeleton, useToast } from '../../components/ui';
import { Select } from '../../components/Select';
import { RowMenu } from '../../components/RowMenu';
import type { RowAction } from '../../components/RowMenu';
import { date, initials, pluralise } from '../../lib/format';
import { useSession } from '../../app/session';
import type { Role } from '../../lib/types';

interface UserRow {
  _id: string; name: string; email: string; role: Role;
  status: string; lastLoginAt: string | null; createdAt: string; permissions: string[];
  mustChangePassword: boolean;
  google: { email: string; linkedAt: string } | null;
  uploadCount: number;
  activeShareCount: number;
}

interface UsersResponse {
  data: UserRow[];
  roles: Role[];
  permissionMatrix: Record<Role, string[]>;
  minPasswordLength: number;
}

function usePersonActions(person: UserRow, isSelf: boolean) {
  const [suspending, setSuspending] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();

  const setStatus = useMutation({
    mutationFn: (status: 'active' | 'suspended') =>
      api(`/admin/users/${person._id}`, { method: 'PATCH', body: { status } }),
    onSuccess: (_r, status) => {
      qc.invalidateQueries();
      toast(status === 'suspended'
        ? {
          kind: 'ok',
          title: `${person.name} can no longer sign in`,
          body: 'Every session they had open was ended. Nothing they uploaded was touched, and their name still sits on all of it. Restore them at any time.',
        }
        : {
          kind: 'ok',
          title: `${person.name} can sign in again`,
          body: 'They start a fresh session with the role shown here.',
        });
    },
    onError: (e: Error) => toast({ kind: 'danger', title: 'Could not change their access', body: e.message }),
  });

  const remove = useMutation({
    mutationFn: () => api(`/admin/users/${person._id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries();
      toast({
        kind: 'ok',
        title: `${person.name}’s account was deleted`,
        body: 'Their sessions were ended and the record is gone. Their files, folders and links are all still here.',
      });
    },
    onError: (e: Error) => toast({ kind: 'danger', title: 'The account was not deleted', body: e.message }),
  });

  const suspended = person.status === 'suspended';

  const actions: RowAction[] = [
    {
      label: 'Suspend access',
      icon: <UserMinus size={16} />,
      hidden: suspended,
      disabled: isSelf,
      disabledReason: 'This is the account you are signed in with.',
      onSelect: () => setSuspending(true),
    },
    {
      label: 'Restore access',
      icon: <UserCheck size={16} />,
      hidden: !suspended,
      onSelect: () => setRestoring(true),
    },
    {
      label: 'Delete account',
      icon: <Trash2 size={16} />,
      danger: true,
      disabled: isSelf,
      disabledReason: 'This is the account you are signed in with — another administrator has to delete it.',
      onSelect: () => setDeleting(true),
    },
  ];

  const dialogs = (
    <>
      {suspending && (
        <ConfirmDialog
          title={`Suspend ${person.name}?`}
          body={
            <>
              They are signed out everywhere and cannot sign in again until you restore them.
              Nothing else changes: their {pluralise(person.uploadCount, 'file')} stay in the
              library with their name on them, and any link they issued keeps working.
            </>
          }
          confirmLabel="Suspend access"
          onConfirm={() => setStatus.mutate('suspended')}
          onClose={() => setSuspending(false)}
        />
      )}
      {restoring && (
        <ConfirmDialog
          title={`Restore ${person.name}?`}
          body={<>They can sign in again straight away, as {person.role}.</>}
          confirmLabel="Restore access"
          onConfirm={() => setStatus.mutate('active')}
          onClose={() => setRestoring(false)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete this account permanently?"
          danger
          requireTyped={person.name}
          requirePassword
          body={
            <>
              The account for <b>{person.email}</b> is destroyed. This is the irreversible one — if
              you only want them out, Suspend does that and can be undone.
              <ul style={{ margin: '10px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
                <li>Every session on the account ends immediately.</li>
                <li>
                  Nothing they uploaded is deleted. Their{' '}
                  <b>{pluralise(person.uploadCount, 'file')}</b> stay exactly where they are — but
                  the name against them reads “Unknown” from now on, because there is no record
                  left to resolve.
                </li>
                <li>
                  {person.activeShareCount > 0
                    ? <>Their <b>{pluralise(person.activeShareCount, 'live share link')}</b> keep working. Revoke those from the Share links screen first if that is not what you want.</>
                    : <>They have no live share links.</>}
                </li>
                <li>The activity log keeps their name on everything they did. That history is not rewritten.</li>
                <li>Nothing here brings the account back. Re-adding them creates a new one.</li>
              </ul>
            </>
          }
          confirmLabel="Delete the account"
          onConfirm={() => remove.mutate()}
          onClose={() => setDeleting(false)}
        />
      )}
    </>
  );

  return { actions, dialogs };
}

function PersonRow({ person, roles, isSelf }: { person: UserRow; roles: Role[]; isSelf: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { actions, dialogs } = usePersonActions(person, isSelf);

  const changeRole = useMutation({
    mutationFn: (role: string) => api(`/admin/users/${person._id}`, { method: 'PATCH', body: { role } }),
    onSuccess: () => {
      qc.invalidateQueries();
      toast({ kind: 'ok', title: 'Role updated', body: 'It applies to their next request — no sign-out needed.' });
    },
    onError: (e: Error) => toast({ kind: 'danger', title: 'Could not change the role', body: e.message }),
  });

  const suspended = person.status === 'suspended';

  return (
    <>
      <div className="person-row">
        <span className="row-icon">{initials(person.name)}</span>

        <div className="row-main">
          <span className="row-title">
            {person.name}
            {isSelf && <span className="tag" style={{ marginLeft: 8 }}>you</span>}
          </span>
          <span className="row-sub">{person.email}</span>
          {suspended && (
            <span className="row-sub row-tight" style={{ marginTop: 3, color: 'var(--danger)' }}>
              <UserMinus size={12} /> suspended — cannot sign in
            </span>
          )}
          {person.mustChangePassword && (
            <span className="row-sub row-tight" style={{ marginTop: 3, color: 'var(--mismatch-ink)' }}>
              <KeyRound size={12} /> has not set their own password yet
            </span>
          )}
          {person.google && (
            <span className="row-sub row-tight" style={{ marginTop: 3 }}>
              <LogIn size={12} /> signs in with Google as {person.google.email}
            </span>
          )}

          <div className="person-controls">
            <Select
              style={{ width: 'auto', minWidth: 116 }}
              value={person.role}
              onChange={(role) => changeRole.mutate(role)}
              options={roles.map((r) => ({ value: r, label: r }))}
              ariaLabel={`Role for ${person.name}`}
            />
            <span className="t-small">Added {date(person.createdAt)}</span>
          </div>
        </div>

        <RowMenu actions={actions} label={`Actions for ${person.name}`} />
      </div>
      {dialogs}
    </>
  );
}

export function Users() {
  const [adding, setAdding] = useState(false);
  const me = useSession((s) => s.user);

  const { data, isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => api<UsersResponse>('/admin/users'),
  });

  if (isLoading || !data) return <div className="page stack-3"><Skeleton h={32} w="30%" /><Skeleton h={260} /></div>;

  return (
    <div className="page stack-5">
      <div className="spread page-head" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <h1 className="t-h1">People</h1>
        <button className="btn btn-primary" onClick={() => setAdding(true)}><UserPlus size={15} /> Add someone</button>
      </div>

      <div className="panel rows">
        {data.data.map((u) => (
          <PersonRow key={u._id} person={u} roles={data.roles} isSelf={u._id === me?._id} />
        ))}
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
        body: `Give ${email} this starting password over a private channel — or tell them to press “Continue with Google” with that same address, which works straight away. Either way they choose a password of their own before using anything.`,
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
          <label className="label" htmlFor="starting-password">Starting password</label>
          {/* A password being handed to somebody else is the one case where it
              genuinely has to be read back — typing it blind and then reading it
              out is how people mistype and lock the new account out. */}
          <PasswordInput
            id="starting-password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
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
          <Select
            value={role}
            onChange={(r) => setRole(r as Role)}
            options={roles.map((r) => ({ value: r, label: r }))}
            ariaLabel="Role"
          />
          <div className="hint">{ROLE_HINT[role] ?? ''}</div>
        </div>
      </div>
    </Modal>
  );
}
