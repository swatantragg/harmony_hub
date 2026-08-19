import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAssetTypes } from '../../lib/vocabulary';
import { Info } from 'lucide-react';
import { Modal, useToast } from '../../components/ui';
import { TagPicker } from '../upload/TagPicker';
import { TypePicker } from '../upload/TypePicker';
import { FolderPicker } from '../folders/FolderPicker';
import { LanguagePicker } from '../../components/LanguagePicker';
import { VERSION_LABELS, carriesLanguage, familyOf } from '../../lib/assetTypes';
import { api } from '../../lib/api';
import type { Asset } from '../../lib/types';

export function EditMetadataDialog({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const [type, setType] = useState(asset.type);
  const [version, setVersion] = useState(asset.version);
  const [description, setDescription] = useState(asset.description);
  const [tags, setTags] = useState<string[]>(asset.tags);
  // The file's own language, not the resolved one — editing here must not silently copy
  // the release's answer onto the file and make it look like somebody chose it.
  const [language, setLanguage] = useState(asset.languageSource === 'file' ? asset.language ?? '' : '');
  const [folderId, setFolderId] = useState(asset.folderId ?? '');
  const qc = useQueryClient();
  const toast = useToast();

  const { data: typeData } = useAssetTypes();
  // Gated on the type selected in this dialog rather than the one on the record: re-typing
  // a reel as a cover has to take the field away in the same breath, or somebody edits a
  // language onto a file that will drop it the moment they save.
  const family = typeData?.data.find((t) => t.type === type)?.family ?? familyOf(type);
  const speaks = carriesLanguage(family);

  const folderChanged = (asset.folderId ?? '') !== folderId;

  const save = useMutation({
    mutationFn: async () => {
      await api(`/assets/${asset.assetId}`, { method: 'PATCH', body: { type, version, description, tags, language: speaks ? language : '' } });
      // Membership is a separate, tiny call — moving a file between folders is a
      // catalogue update and never touches the stored object.
      if (folderChanged) {
        await api(`/folders/${folderId || 'none'}/assets`, { method: 'POST', body: { assetIds: [asset.assetId] } });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries();
      toast({
        kind: 'ok',
        title: 'Details updated',
        body: folderChanged
          ? 'Search and filters reflect the change immediately. No file was moved in storage.'
          : 'Search and filters reflect the change immediately.',
      });
      onClose();
    },
    onError: (e: Error) => toast({ kind: 'danger', title: 'Could not save', body: e.message }),
  });

  return (
    <Modal
      title="Edit details"
      subtitle="Classification, version, folder, tags and description. The file itself is not touched."
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>Save changes</button>
        </>
      }
    >
      <div className="stack-4">
        <div className="row" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <TypePicker value={type} onChange={setType} label="Asset type" />
          {/* 150px beside the type picker, full width once it has wrapped below it. */}
          <div className="field" style={{ flex: '1 1 150px', minWidth: 150 }}>
            <label className="label">Version label</label>
            <select className="select" value={version} onChange={(e) => setVersion(e.target.value)}>
              {VERSION_LABELS.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
        </div>

        <div className="row" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <FolderPicker
            value={folderId}
            onChange={setFolderId}
            hint="Move this file into a folder, or take it out. Google Drive re-parents it — no bytes are copied, however large it is."
          />
          {/* Audio and video only. Artwork and paperwork have no language of their own —
              what the master log shows for them is inherited from their release. */}
          {speaks && (
          <LanguagePicker
            value={language}
            onChange={setLanguage}
            hint={
              asset.songId
                ? `Blank means this file follows its release${asset.languageSource === 'release' && asset.language ? ` — currently ${asset.language}` : ''}. Fill it in only when this file differs.`
                : 'This file belongs to no release, so this is the only place it can get a language.'
            }
          />
          )}
        </div>

        {folderChanged && (
          <div className="note indigo">
            <Info size={15} />
            <div>
              <b>The file moves in Google Drive too.</b> It keeps its file id{' '}
              <span className="keytext">{asset.drive.fileId}</span>, so no bytes are copied and every
              share link keeps working — but open the Drive and you will find it in the new folder,
              which is the whole point of the two staying in step.
            </div>
          </div>
        )}

        <div className="field">
          <label className="label">Description</label>
          <textarea
            className="textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this file for? Where was it used?"
          />
        </div>

        <TagPicker value={tags} onChange={setTags} />
      </div>
    </Modal>
  );
}
