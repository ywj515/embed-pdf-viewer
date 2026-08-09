import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PluginRegistry,
  setDocumentLoaded,
  startLoadingDocument,
} from '../../core/dist/index.js';
import {
  PdfAnnotationSubtype,
  PdfPermissionFlag,
  PdfStandardFont,
  PdfTaskHelper,
  PdfTextAlignment,
  PdfVerticalAlignment,
  Rotation,
  Task,
} from '../../models/dist/index.js';
import { AnnotationPlugin, AnnotationPluginPackage } from '../dist/index.js';

const documentId = 'commit-race-document';
const annotationId = 'managed-freetext-race';

const revisions = (editRevision, committedLayoutRevision) => ({
  managedFreeText: true,
  yubin: {
    revisions: { editRevision, committedLayoutRevision },
  },
});

const revisionOf = (annotation) => annotation.custom.yubin.revisions;

const waitForTask = (task) =>
  new Promise((resolve, reject) => task.wait(resolve, reject));

test('keeps a newer managed FreeText update pending when an older commit resolves', async () => {
  const firstEngineTask = new Task();
  const secondEngineTask = new Task();
  const updateCalls = [];
  let scope;
  let stateAtSecondUpdate;

  const revision2 = {
    id: annotationId,
    type: PdfAnnotationSubtype.FREETEXT,
    pageIndex: 0,
    rect: { origin: { x: 10, y: 20 }, size: { width: 120, height: 30 } },
    contents: 'Insert text',
    fontFamily: PdfStandardFont.Helvetica,
    fontSize: 12,
    fontColor: '#000000',
    textAlign: PdfTextAlignment.Left,
    verticalAlign: PdfVerticalAlignment.Top,
    opacity: 1,
    flags: ['print'],
    custom: revisions(2, 2),
  };

  const engine = {
    getAllAnnotations: () => PdfTaskHelper.resolve({ 0: [revision2] }),
    updatePageAnnotation: (_document, _page, annotation) => {
      updateCalls.push(annotation);
      if (updateCalls.length === 1) return firstEngineTask;
      if (updateCalls.length === 2) {
        stateAtSecondUpdate = scope.getAnnotationById(annotationId);
        return secondEngineTask;
      }
      throw new Error(`unexpected update call ${updateCalls.length}`);
    },
  };

  const registry = new PluginRegistry(engine);
  const store = registry.getStore();
  const config = {
    ...AnnotationPluginPackage.manifest.defaultConfig,
    autoCommit: false,
  };
  const initialState = AnnotationPluginPackage.initialState(store.getState().core, config);
  store.addPluginReducer(
    AnnotationPluginPackage.manifest.id,
    AnnotationPluginPackage.reducer,
    initialState,
  );

  const plugin = new AnnotationPlugin(AnnotationPluginPackage.manifest.id, registry, config);
  await plugin.initialize();

  const document = {
    id: documentId,
    pageCount: 1,
    pages: [
      {
        index: 0,
        size: { width: 612, height: 792 },
        rotation: Rotation.Degree0,
        objectNumber: 1,
      },
    ],
    isEncrypted: false,
    isOwnerUnlocked: true,
    permissions: PdfPermissionFlag.AllowAll,
    normalizedRotation: true,
  };

  store.dispatchToCore(startLoadingDocument(documentId, 'race.pdf', 1, Rotation.Degree0, true, true));
  store.dispatchToCore(setDocumentLoaded(documentId, document));
  scope = plugin.provides().forDocument(documentId);

  // Make the already-persisted revision 2 dirty, then begin its engine update.
  scope.updateAnnotation(0, annotationId, { custom: revisions(2, 2) });
  const commitTask = scope.commit();
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(revisionOf(updateCalls[0]), {
    editRevision: 2,
    committedLayoutRevision: 2,
  });

  // The real Notes flow replaces the model object while revision 2 is in flight.
  scope.updateAnnotation(0, annotationId, {
    contents: '안녕하세요안녕하세요안녕하세요',
    fontFamily: PdfStandardFont.NotoSansKR,
    custom: revisions(4, 2),
  });

  firstEngineTask.resolve(true);

  // The plugin automatically schedules the follow-up commit. At its entry,
  // revision 4 must still be the dirty pending object—not falsely synced by
  // completion of revision 2.
  assert.equal(updateCalls.length, 2);
  assert.equal(stateAtSecondUpdate.commitState, 'dirty');
  assert.equal(scope.getState().hasPendingChanges, true);
  assert.deepEqual(revisionOf(stateAtSecondUpdate.object), {
    editRevision: 4,
    committedLayoutRevision: 2,
  });
  assert.equal(updateCalls[1].fontFamily, PdfStandardFont.NotoSansKR);
  assert.equal(revisionOf(updateCalls[1]).editRevision, 4);

  // Mirror the Notes post-commit revision acknowledgement after the plugin
  // has marked the successful engine object synced.
  const unsubscribe = scope.onAnnotationEvent((event) => {
    if (
      event.type === 'update' &&
      event.committed &&
      revisionOf(event.annotation).editRevision === 4
    ) {
      queueMicrotask(() =>
        scope.syncAnnotationObject(annotationId, { custom: revisions(4, 4) }),
      );
    }
  });

  secondEngineTask.resolve(true);
  await waitForTask(commitTask);
  await Promise.resolve();

  const committed = scope.getAnnotationById(annotationId);
  assert.equal(updateCalls.length, 2);
  assert.equal(committed.commitState, 'synced');
  assert.equal(scope.getState().hasPendingChanges, false);
  assert.deepEqual(revisionOf(committed.object), {
    editRevision: 4,
    committedLayoutRevision: 4,
  });

  unsubscribe();
  plugin.destroy();
});

test('turns an in-flight creation edit into one follow-up update for the same UID', async () => {
  const createTask = new Task();
  const updateTask = new Task();
  const createCalls = [];
  const updateCalls = [];
  let scope;

  const engine = {
    getAllAnnotations: () => PdfTaskHelper.resolve({}),
    createPageAnnotation: (_document, _page, annotation) => {
      createCalls.push(annotation);
      return createTask;
    },
    updatePageAnnotation: (_document, _page, annotation) => {
      updateCalls.push(annotation);
      return updateTask;
    },
  };

  const registry = new PluginRegistry(engine);
  const store = registry.getStore();
  const config = {
    ...AnnotationPluginPackage.manifest.defaultConfig,
    autoCommit: false,
  };
  store.addPluginReducer(
    AnnotationPluginPackage.manifest.id,
    AnnotationPluginPackage.reducer,
    AnnotationPluginPackage.initialState(store.getState().core, config),
  );
  const plugin = new AnnotationPlugin(AnnotationPluginPackage.manifest.id, registry, config);
  await plugin.initialize();
  const document = {
    id: documentId,
    pageCount: 1,
    pages: [{
      index: 0,
      size: { width: 612, height: 792 },
      rotation: Rotation.Degree0,
      objectNumber: 1,
    }],
    isEncrypted: false,
    isOwnerUnlocked: true,
    permissions: PdfPermissionFlag.AllowAll,
    normalizedRotation: true,
  };
  store.dispatchToCore(startLoadingDocument(documentId, 'create-race.pdf', 1, Rotation.Degree0, true, true));
  store.dispatchToCore(setDocumentLoaded(documentId, document));
  scope = plugin.provides().forDocument(documentId);

  scope.createAnnotation(0, {
    id: annotationId,
    type: PdfAnnotationSubtype.FREETEXT,
    pageIndex: 0,
    rect: { origin: { x: 10, y: 20 }, size: { width: 120, height: 30 } },
    contents: 'Insert text',
    fontFamily: PdfStandardFont.NotoSansKR,
    fontSize: 12,
    fontColor: '#000000',
    textAlign: PdfTextAlignment.Left,
    verticalAlign: PdfVerticalAlignment.Top,
    opacity: 1,
    flags: ['print'],
    custom: revisions(2, 2),
  });
  const commitTask = scope.commit();
  assert.equal(createCalls.length, 1);
  assert.equal(updateCalls.length, 0);

  scope.updateAnnotation(0, annotationId, {
    contents: '안녕하세요 Noto Sans KR duplicate test',
    fontFamily: PdfStandardFont.NotoSansKR,
    custom: revisions(4, 2),
  });
  createTask.resolve(annotationId);

  assert.equal(createCalls.length, 1, 'the resolved native create must not be repeated');
  assert.equal(updateCalls.length, 1, 'the newer model must update the native annotation in place');
  assert.equal(scope.getAnnotationById(annotationId).commitState, 'dirty');
  assert.equal(updateCalls[0].id, annotationId);
  assert.equal(updateCalls[0].fontFamily, PdfStandardFont.NotoSansKR);
  assert.equal(revisionOf(updateCalls[0]).editRevision, 4);

  const unsubscribe = scope.onAnnotationEvent((event) => {
    if (
      event.type === 'update' &&
      event.committed &&
      revisionOf(event.annotation).editRevision === 4
    ) {
      queueMicrotask(() =>
        scope.syncAnnotationObject(annotationId, { custom: revisions(4, 4) }),
      );
    }
  });
  updateTask.resolve(true);
  await waitForTask(commitTask);
  await Promise.resolve();
  assert.equal(createCalls.length, 1);
  assert.equal(updateCalls.length, 1);
  assert.equal(scope.getAnnotationById(annotationId).commitState, 'synced');
  assert.equal(scope.getState().hasPendingChanges, false);
  assert.deepEqual(revisionOf(scope.getAnnotationById(annotationId).object), {
    editRevision: 4,
    committedLayoutRevision: 4,
  });

  await waitForTask(scope.commit());
  await waitForTask(scope.commit());
  assert.equal(createCalls.length, 1, 'repeated commits must not create another annotation');
  assert.equal(updateCalls.length, 1, 'repeated commits without changes must be no-ops');

  unsubscribe();
  plugin.destroy();
});

test('rejects a failed creation without marking it committed', async () => {
  const createTask = new Task();
  const failedId = 'managed-freetext-failed-create';
  const engine = {
    getAllAnnotations: () => PdfTaskHelper.resolve({}),
    createPageAnnotation: () => createTask,
  };
  const registry = new PluginRegistry(engine);
  const store = registry.getStore();
  const config = {
    ...AnnotationPluginPackage.manifest.defaultConfig,
    autoCommit: false,
  };
  store.addPluginReducer(
    AnnotationPluginPackage.manifest.id,
    AnnotationPluginPackage.reducer,
    AnnotationPluginPackage.initialState(store.getState().core, config),
  );
  const plugin = new AnnotationPlugin(AnnotationPluginPackage.manifest.id, registry, config);
  await plugin.initialize();
  const document = {
    id: documentId,
    pageCount: 1,
    pages: [{
      index: 0,
      size: { width: 612, height: 792 },
      rotation: Rotation.Degree0,
      objectNumber: 1,
    }],
    isEncrypted: false,
    isOwnerUnlocked: true,
    permissions: PdfPermissionFlag.AllowAll,
    normalizedRotation: true,
  };
  store.dispatchToCore(startLoadingDocument(documentId, 'failed-create.pdf', 1, Rotation.Degree0, true, true));
  store.dispatchToCore(setDocumentLoaded(documentId, document));
  const scope = plugin.provides().forDocument(documentId);
  const events = [];
  const unsubscribe = scope.onAnnotationEvent((event) => events.push(event));
  scope.createAnnotation(0, {
    id: failedId,
    type: PdfAnnotationSubtype.FREETEXT,
    pageIndex: 0,
    rect: { origin: { x: 10, y: 20 }, size: { width: 120, height: 30 } },
    contents: 'failed native creation',
    fontFamily: PdfStandardFont.NotoSansKR,
    fontSize: 12,
    fontColor: '#000000',
    textAlign: PdfTextAlignment.Left,
    verticalAlign: PdfVerticalAlignment.Top,
    opacity: 1,
    flags: ['print'],
    custom: { yubin: { managedFreeText: true } },
  });
  const commitTask = scope.commit();
  createTask.reject({ code: 1, message: 'native create failed' });
  let rejected;
  try {
    await waitForTask(commitTask);
    assert.fail('commit unexpectedly resolved');
  } catch (error) {
    rejected = error;
  }
  assert.equal(rejected.type, 'reject');
  assert.equal(rejected.reason.message, 'native create failed');
  assert.equal(scope.getAnnotationById(failedId).commitState, 'new');
  assert.equal(scope.getState().hasPendingChanges, true);
  assert.equal(events.some((event) => event.committed === true), false);
  unsubscribe();
  plugin.destroy();
});
