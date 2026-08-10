import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { Modal, useToast } from '../../components/ui';
import { TagPicker } from '../upload/TagPicker';
import { TypePicker } from '../upload/TypePicker';
import { FolderPicker } from '../folders/FolderPicker';
import { VERSION_LABELS } from '../../lib/assetTypes';
import { api } from '../../lib/api';
import type { Asset } from '../../lib/types';

export function EditMetadataDialog({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const [type, setType] = useState(asset.type);
  const [version, setVersion] = useState(asset.version);
  const [description, setDescription] = useState(asset.description);
  const [tags, setTags] = useState<string[]>(asset.tags);
  const [folderId, setFolderId] = useState(asset.folderId ?? '');
  const qc = useQueryClient();
  const toast = useToast();

  const folderChanged = (asset.folderId ?? '') !== folderId;

  const save = useMutation({
    mutationFn: async () => {
      await api(`/assets/${asset.assetId}`, { method: 'PATCH', body: { type, version, description, tags } });
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
          <div className="field" style={{ width: 150 }}>
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
