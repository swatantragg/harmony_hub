import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Users, ArrowLeft, Music4, Instagram, Youtube, MapPin, Disc3 } from 'lucide-react';
import { api } from '../../lib/api';
import { CardSkeletons, EmptyState, Skeleton, useDebounced } from '../../components/ui';
import { AssetCard } from '../assets/AssetCard';
import { AssetDrawer } from '../assets/AssetDrawer';
import { bytes, date, pluralise } from '../../lib/format';
import type { Artist } from '../../lib/types';

const FAMILY_ORDER = ['Audio', 'Video', 'Image', 'Document'] as const;

export function ArtistList() {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q);
  const { data, isLoading } = useQuery({
    queryKey: ['artists', debounced],
    queryFn: () => api<{ data: Artist[] }>(`/artists${debounced ? `?q=${encodeURIComponent(debounced)}` : ''}`),
  });

  return (
    <div className="page stack-4">
      <div className="page-head">
        <h1 className="t-h1">Artists</h1>
        <p className="t-body" style={{ maxWidth: '62ch', marginTop: 6 }}>
          Every artist on the roster, with their releases and the files attached to each. An artist’s
          name can be changed at any time — it never touches a stored file.
        </p>
        <div className="searchbar" style={{ maxWidth: 380, marginTop: 16 }}>
          <Users size={17} color="var(--ink-3)" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or genre" aria-label="Filter artists" />
        </div>
      </div>

      {isLoading ? (
        <CardSkeletons n={5} />
      ) : (
        <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(256px, 1fr))' }}>
          {data?.data.map((a) => (
            <Link key={a._id} to={`/artists/${a._id}`} className="card" style={{ textDecoration: 'none' }}>
              <div
                className="card-art"
                data-family="Audio"
                style={{ height: 96, alignItems: 'center', justifyContent: 'center' }}
              >
                <span
                  style={{
                    width: 50, height: 50, borderRadius: 15, background: 'var(--wash-chip)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: 'var(--display)', fontWeight: 600, fontSize: 19, color: 'var(--indigo-deep)',
                  }}
                >
                  {a.name.slice(0, 2).toUpperCase()}
                </span>
              </div>
              <div className="card-body">
                <div className="card-title" style={{ fontSize: 15 }}>{a.name}</div>
                <div className="card-sub">{a.genre} · {a.label}</div>
                <div className="card-foot">
                  <span className="t-small">{pluralise(a.songCount, 'song')} · {pluralise(a.assetCount, 'file')}</span>
                  <span className="t-small" style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{bytes(a.totalBytes)}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function ArtistDetail() {
  const { id } = useParams();
  const [openAsset, setOpenAsset] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['artist', id],
    queryFn: () => api<Artist>(`/artists/${id}`),
  });

  if (isLoading || !data) {
    return <div className="page stack-3"><Skeleton h={34} w="40%" /><Skeleton h={110} /><CardSkeletons n={4} /></div>;
  }

  return (
    <div className="page stack-5">
      <div>
        <Link className="btn btn-ghost btn-sm" to="/artists" style={{ marginBottom: 12, paddingLeft: 0 }}>
          <ArrowLeft size={14} /> All artists
        </Link>

        <div className="panel">
          <div className="panel-body" style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
            <div
              style={{
                width: 92, height: 92, borderRadius: 22, flex: 'none',
                background: 'linear-gradient(135deg, var(--indigo-soft), var(--indigo-wash))',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: 'var(--display)', fontWeight: 600, fontSize: 30, color: 'var(--indigo-deep)',
              }}
            >
              {data.name.slice(0, 2).toUpperCase()}
            </div>

            <div className="grow" style={{ minWidth: 240 }}>
              <h1 className="t-h1">{data.name}</h1>
              <div className="wrap-gap" style={{ marginTop: 9 }}>
                <span className="pill"><b>Genre</b> · {data.genre}</span>
                <span className="pill"><b>Label</b> · {data.label}</span>
                {data.city && <span className="pill"><MapPin size={11} /> {data.city}</span>}
              </div>
              <p className="t-body" style={{ marginTop: 12, maxWidth: '62ch' }}>{data.bio}</p>
              <div className="wrap-gap" style={{ marginTop: 10 }}>
                {data.socials.map((s) => (
                  <span key={s.platform} className="t-small row-tight">
                    {s.platform === 'Instagram' ? <Instagram size={13} /> : <Youtube size={13} />} {s.handle}
                  </span>
                ))}
              </div>
            </div>

            <div className="tiles" style={{ gridTemplateColumns: 'repeat(2, minmax(120px,1fr))', minWidth: 250, alignSelf: 'flex-start' }}>
              <div className="stat plain">
                <div className="stat-k">Songs</div>
                <div className="stat-v" style={{ fontSize: 24 }}>{data.songCount}</div>
              </div>
              <div className="stat plain">
                <div className="stat-k">Files</div>
                <div className="stat-v" style={{ fontSize: 24 }}>{data.assetCount}</div>
                <div className="stat-n">{bytes(data.totalBytes)}</div>
              </div>
            </div>
          </div>

          <div className="panel-body" style={{ borderTop: '1px solid var(--line)', paddingTop: 14 }}>
            <div className="wrap-gap">
              {FAMILY_ORDER.map((fam) => (
                <Link
                  key={fam}
                  className="chip"
                  to={`/search?artistId=${data._id}&family=${fam}`}
                  style={{ opacity: (data.byFamily[fam] ?? 0) === 0 ? 0.45 : 1 }}
                >
                  {fam} <span className="count">{data.byFamily[fam] ?? 0}</span>
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>

      <section>
        <h2 className="t-h2 row-tight" style={{ marginBottom: 14 }}><Disc3 size={16} color="var(--ink-3)" /> Discography</h2>
        {data.songs?.length === 0 ? (
          <EmptyState icon={<Music4 size={24} />} title="No releases yet" body="Songs added for this artist will appear here." />
        ) : (
          <div className="panel" style={{ overflow: 'hidden' }}>
            <div className="table-scroll">
              <table className="tbl">
                <thead><tr><th>Song</th><th>Language</th><th>Mood</th><th>Released</th><th>Files</th></tr></thead>
                <tbody>
                  {data.songs?.map((s) => (
                    <tr key={s._id} onClick={() => { window.location.hash = `#/songs/${s._id}`; }}>
                      <td style={{ fontWeight: 600 }}>{s.title}</td>
                      <td className="t-small">{s.language}</td>
                      <td className="t-small">{s.mood}</td>
                      <td className="t-small">{date(s.releaseDate)}</td>
                      <td className="t-small" style={{ fontFamily: 'var(--mono)' }}>{s.assetCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {(data.gallery?.length ?? 0) > 0 && (
        <section>
          <h2 className="t-h2" style={{ marginBottom: 14 }}>Image gallery</h2>
          <div className="cards">
            {data.gallery?.map((a) => <AssetCard key={a.assetId} asset={a} onOpen={(x) => setOpenAsset(x.assetId)} />)}
          </div>
        </section>
      )}

      {openAsset && <AssetDrawer assetId={openAsset} onClose={() => setOpenAsset(null)} />}
    </div>
  );
}
