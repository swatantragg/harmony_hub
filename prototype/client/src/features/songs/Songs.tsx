import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, Disc3, UploadCloud, AlertTriangle, Trash2, Music2, Film, Image as ImageIcon, FileText,
} from 'lucide-react';
import { api } from '../../lib/api';
import { CardSkeletons, EmptyState, Skeleton, useDebounced } from '../../components/ui';
import { AssetCard } from '../assets/AssetCard';
import { AssetDrawer } from '../assets/AssetDrawer';
import { bytes, date, pluralise } from '../../lib/format';
import type { SongDetail, SongRow, Family } from '../../lib/types';
import { useSession } from '../../app/session';

const FAMILY_ICON: Record<string, typeof Music2> = { Audio: Music2, Video: Film, Image: ImageIcon, Document: FileText };
const FAMILY_ORDER: Family[] = ['Audio', 'Video', 'Image', 'Document'];

export function SongList() {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q);
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['songs', debounced],
    queryFn: () => api<{ data: SongRow[] }>(`/songs${debounced ? `?q=${encodeURIComponent(debounced)}` : ''}`),
  });

  return (
    <div className="page stack-4">
      <div className="page-head">
        <h1 className="t-h1">Songs</h1>
        <p className="t-body" style={{ maxWidth: '62ch', marginTop: 6 }}>
          Each song gathers every file made for it — masters, covers, videos, reels and lyrics — in
          one place, grouped by kind.
        </p>
        <div className="searchbar" style={{ maxWidth: 380, marginTop: 16 }}>
          <Disc3 size={17} color="var(--ink-3)" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by title" aria-label="Filter songs" />
        </div>
      </div>

      {isLoading ? (
        <Skeleton h={300} />
      ) : (
        <div className="panel" style={{ overflow: 'hidden' }}>
          <div className="table-scroll">
            <table className="tbl">
              <thead>
                <tr><th>Song</th><th>Artist</th><th>Language</th><th>Mood</th><th>Released</th><th>Files</th><th /></tr>
              </thead>
              <tbody>
                {data?.data.map((s) => (
                  <tr key={s._id} onClick={() => navigate(`/songs/${s._id}`)}>
                    <td style={{ fontWeight: 600 }}>{s.title}</td>
                    <td className="t-small">{s.artistName}</td>
                    <td className="t-small">{s.language}</td>
                    <td className="t-small">{s.mood}</td>
                    <td className="t-small">{date(s.releaseDate)}</td>
                    <td className="t-small" style={{ fontFamily: 'var(--mono)' }}>{s.assetCount}</td>
                    <td>
                      {(s.needsAttention ?? 0) > 0 && (
                        <span className="badge" data-status="MISSING" title="Some files on this song need attention">
                          <AlertTriangle size={11} /> {s.needsAttention}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export function SongDetailPage() {
  const { id } = useParams();
  const [openAsset, setOpenAsset] = useState<string | null>(null);
  const can = useSession((s) => s.can);

  const { data, isLoading } = useQuery({
    queryKey: ['song', id],
    queryFn: () => api<SongDetail>(`/songs/${id}`),
  });

  if (isLoading || !data) {
    return <div className="page stack-3"><Skeleton h={32} w="36%" /><Skeleton h={94} /><CardSkeletons n={6} /></div>;
  }

  const attention = data.assets.filter((a) => ['MISSING', 'MISMATCH'].includes(a.availability.status));

  return (
    <div className="page stack-5">
      <div>
        <Link className="btn btn-ghost btn-sm" to="/songs" style={{ marginBottom: 12, paddingLeft: 0 }}>
          <ArrowLeft size={14} /> All songs
        </Link>

        <div className="spread" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 14 }}>
          <div>
            <div className="eyebrow" style={{ marginBottom: 7 }}>
              <Link to={`/artists/${data.artistId}`}>{data.artistName}</Link>
              {data.featuring?.length ? ` · feat. ${data.featuring.join(', ')}` : ''}
            </div>
            <h1 className="t-h1">{data.title}</h1>
            <div className="wrap-gap" style={{ marginTop: 11 }}>
              <span className="pill"><b>Language</b> · {data.language}</span>
              <span className="pill"><b>Mood</b> · {data.mood}</span>
              <span className="pill"><b>Released</b> · {date(data.releaseDate)}</span>
              {data.isrc && <span className="pill"><b>ISRC</b> · {data.isrc}</span>}
              <span className="pill"><b>Total</b> · {bytes(data.totalBytes)}</span>
            </div>
          </div>

          {can('asset:upload') && (
            <Link className="btn btn-spark" to={`/upload?songId=${data._id}`}>
              <UploadCloud size={16} /> Add files to this song
            </Link>
          )}
        </div>
      </div>

      {attention.length > 0 && (
        <div className="note danger">
          <AlertTriangle size={15} />
          <div>
            <b>{pluralise(attention.length, 'file on this song needs', 'files on this song need')} attention.</b>{' '}
            {attention.map((a) => a.displayName).join(', ')} — open each one to see what happened and
            what you can do about it.
          </div>
        </div>
      )}

      {data.assets.length === 0 ? (
        <EmptyState
          icon={<UploadCloud size={26} />}
          title="No files on this song yet"
          body="Add the master audio, the cover art, the reels and anything else made for this release. Everything stays grouped here."
          action={can('asset:upload') ? <Link className="btn btn-spark" to={`/upload?songId=${data._id}`}>Upload the first file</Link> : undefined}
        />
      ) : (
        FAMILY_ORDER.filter((f) => data.assetsByFamily[f]?.length).map((family) => {
          const Icon = FAMILY_ICON[family];
          const assets = data.assetsByFamily[family];
          return (
            <section key={family}>
              <div className="spread" style={{ marginBottom: 13 }}>
                <h2 className="t-h2 row-tight">
                  <span
                    data-family={family}
                    style={{
                      width: 26, height: 26, borderRadius: 8,
                      background: 'linear-gradient(135deg, var(--fam-a), var(--fam-b))',
                      color: 'var(--fam-ink)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    <Icon size={14} />
                  </span>
                  {family}
                  <span className="t-small" style={{ fontWeight: 500 }}>{pluralise(assets.length, 'file')}</span>
                </h2>
                <Link className="btn btn-ghost btn-sm" to={`/search?family=${family}&artistId=${data.artistId}`}>
                  See all {family.toLowerCase()} for this artist
                </Link>
              </div>
              <div className="cards">
                {assets.map((a) => (
                  <AssetCard key={a.assetId} asset={a} selected={openAsset === a.assetId} onOpen={(x) => setOpenAsset(x.assetId)} />
                ))}
              </div>
            </section>
          );
        })
      )}

      {data.recycleBin.length > 0 && (
        <section>
          <h2 className="t-h2 row-tight" style={{ marginBottom: 12 }}>
            <Trash2 size={15} color="var(--ink-3)" /> Recycle bin
            <span className="t-small" style={{ fontWeight: 500 }}>recoverable for 30 days</span>
          </h2>
          <div className="panel">
            <div className="panel-body stack-2">
              {data.recycleBin.map((a) => (
                <div key={a.assetId} className="spread">
                  <span className="t-mono t-small">{a.displayName}</span>
                  <span className="t-small">deleted {date(a.deletedAt!)}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {openAsset && <AssetDrawer assetId={openAsset} onClose={() => setOpenAsset(null)} />}
    </div>
  );
}
