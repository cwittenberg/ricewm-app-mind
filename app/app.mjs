import {
  defineApp,
  Column,
  Row,
  Label,
  Button,
  IconButton,
  Tooltip,
  ToolBar,
  TextField,
  Slider,
  Message,
  State,
  Workspace,
  ObjectCanvas,
  VisualDocumentModel,
  createVisualDocument,
  createVisualTextRenderer,
  serializeVisualDocument,
  parseVisualDocument,
  VisualDocumentSession,
  ScrollView,
  TabView,
  TabPage,
  ChipGroup,
  Chip,
  ColorPalette,
  TokenInput,
  CommandRegistry,
  Ribbon,
  Icons,
  FileHandoff,
  exportVisualPresentation,
  AppCapabilityRegistry,
  layoutObjects,
} from '@ricewm/app';

export default defineApp({
  async start({ app, bus, services, createWindow }) {
    let value = createVisualDocument({
      objects: [
        {
          id: 'idea',
          text: 'My next big idea',
          x: 80,
          y: 200,
          width: 210,
          height: 70,
          shape: 'roundedRect',
          droppable: true,
        },
        {
          id: 'discover',
          text: 'Discover',
          parent: 'idea',
          x: 430,
          y: 60,
          width: 190,
          height: 64,
          shape: 'roundedRect',
          droppable: true,
          style: { fill: '#DBEAFE', foreground: '#172033' },
        },
        {
          id: 'design',
          text: 'Design',
          parent: 'idea',
          x: 430,
          y: 220,
          width: 190,
          height: 64,
          shape: 'roundedRect',
          droppable: true,
          style: { fill: '#DCFCE7', foreground: '#172033' },
        },
        {
          id: 'deliver',
          text: 'Deliver',
          parent: 'idea',
          x: 430,
          y: 380,
          width: 190,
          height: 64,
          shape: 'roundedRect',
          droppable: true,
          style: { fill: '#FEF3C7', foreground: '#172033' },
        },
      ],
      connections: [
        {
          id: 'a',
          source: 'idea',
          target: 'discover',
          routing: 'orthogonal',
          sourcePort: 'right',
          targetPort: 'left',
        },
        {
          id: 'b',
          source: 'idea',
          target: 'design',
          routing: 'orthogonal',
          sourcePort: 'right',
          targetPort: 'left',
        },
        {
          id: 'c',
          source: 'idea',
          target: 'deliver',
          routing: 'orthogonal',
          sourcePort: 'right',
          targetPort: 'left',
        },
      ],
    });
    try {
      value = parseVisualDocument(
        new TextDecoder().decode(await services.files.read({ path: 'recovery.json' })),
      );
    } catch {}
    const model = new VisualDocumentModel({ value });
    const session = new VisualDocumentSession({ services, history: model });
    const handoff = new FileHandoff({ services });
    const status = new Label({ text: 'Drag topics · F2 edits · Home fits · Ctrl-wheel zooms' });
    const title = new TextField({ value: '', accessibleName: 'Topic title' });
    const outline = new Column({ text: 'panel:fixed:padding=12:gap=8' });
    const tagDraft = new TextField({ value: '', accessibleName: 'Tags, comma separated' });
    const deleteTagChips = new Map();
    const tagHost = new Workspace({
      render(view) {
        if (view.width < 1 || view.height < 1) return;
        let left = 0;
        let top = 0;
        for (const tag of model.value.tags) {
          const width = Math.min(view.width, Math.max(48, tag.label.length * 10 + 24));
          if (left + width > view.width) {
            left = 0;
            top += 42;
          }
          if (top + 36 > view.height) break;
          let chip = deleteTagChips.get(tag.id);
          if (!chip) {
            chip = new Chip({
              text: tag.label,
              color: tag.color,
              accessibleName: `Delete tag ${tag.label}`,
            });
            chip.on(Message.ACTIVATE, () => model.removeTag(tag.id));
            deleteTagChips.set(tag.id, chip);
          }
          view.place(tag.id, chip, [left, top, width, 36]);
          left += width + 6;
        }
      },
    });
    let selected = null;
    let serial = Date.now();
    let file = { path: 'mind-map.json' };
    let recovery = Promise.resolve();
    let outlineControls = [];
    const current = () => model.value.objects.find((object) => object.id === selected);
    title.on(Message.VALUE_CHANGED, () => {
      const topic = current();
      const text = title.getProperty('value');
      if (!topic || topic.text === text) return;
      model.updateObjects([topic.id], { text });
      if (status.getProperty('text') !== 'Topic updated') {
        status.text = 'Topic updated';
      }
    });
    function refreshTags() {
      tagHost.refresh();
    }
    const addTag = new Button({ text: 'Add tags' });
    addTag.on(Message.ACTIVATE, () => {
      const labels = [
        ...new Set(
          tagDraft
            .getProperty('value')
            .split(',')
            .map((label) => label.trim())
            .filter(Boolean),
        ),
      ];
      if (!current() || !labels.length) {
        status.text = 'Select a topic and enter a tag.';
        return;
      }
      for (const label of labels) {
        if (!model.value.tags.some((tag) => tag.label === label)) {
          model.addTag({ label, color: '#DBEAFE' });
        }
      }
      const tagIds = labels.map(
        (label) => model.value.tags.find((item) => item.label === label).id,
      );
      model.updateObjects([selected], {
        tags: [...new Set([...(current().tags || []), ...tagIds])],
      });
      tagDraft.setProperty('value', '');
      refreshTags();
    });
    const safe = (action) => async () => {
      try {
        return await action();
      } catch (error) {
        status.text = String(error.message || error);
      }
    };
    function toggleBranch(object) {
      if (!object || !model.value.objects.some((item) => item.parent === object.id)) return;
      model.setCollapsed(object.id, !object.collapsed);
      void syncZoom();
    }
    let mapSurface;
    let branchMarkers = [];
    const expandButtons = new Map();
    const textRenderer = await createVisualTextRenderer({ services });
    app.on(Message.APP_CLOSE, () => textRenderer.close());
    class TopicCanvas extends ObjectCanvas {
      beginEdit(id) {
        this.find('object-canvas-surface').setProperty('focused', false);
        const started = super.beginEdit(id);
        if (!started) return started;
        const input = this.find('object-text-editor');
        input.setSelection(Array.from(input.getProperty('value')).length);
        return started;
      }
    }
    const canvas = new TopicCanvas({
      history: model,
      textRenderer,
      width: 760,
      height: 460,
      minimap: false,
      colors: { background: '#E8EEF5' },
      onSelection(ids) {
        selected = ids[0] || null;
        title.setProperty('value', current()?.text || '');
        title.setProperty('enabled', Boolean(current()));
        editTags.setProperty('enabled', Boolean(current()));
        colorApply.setProperty('enabled', Boolean(current()));
        palette.setProperty('enabled', Boolean(current()));
        refreshTags();
        details.refresh();
      },
    });
    canvas.setProperty('name', 'mind-map');
    canvas.setProperty('state', State.ENABLED | State.EXPANSIVE);
    const zoomSlider = new Slider({
      name: 'map-zoom',
      accessibleName: 'Map zoom percentage',
      min: 10,
      max: 400,
      step: 5,
      value: 100,
    });
    const zoomLabel = new Label({ text: 'Zoom 100%' });
    let syncingZoom = false;
    let syncedZoomValue = 100;
    let markerLayout = '';
    let zoomInspection = 0;
    function markerVisible(id) {
      const objects = new Map(model.value.objects.map((object) => [object.id, object]));
      let topic = objects.get(id);
      if (!topic || !matchesTags(topic)) return false;
      const visited = new Set([id]);
      while (topic.parent) {
        if (visited.has(topic.parent)) return false;
        visited.add(topic.parent);
        topic = objects.get(topic.parent);
        if (!topic || topic.collapsed) return false;
      }
      return true;
    }
    async function syncZoom() {
      const inspection = ++zoomInspection;
      const state = await canvas.inspect({ start: 0, limit: 200 });
      if (inspection !== zoomInspection) return;
      branchMarkers = state.objects.filter((object) => {
        const topic = model.value.objects.find((item) => item.id === object.id);
        return (
          object.visible &&
          topic?.collapsed &&
          markerVisible(object.id) &&
          model.value.objects.some((item) => item.parent === object.id)
        );
      });
      const nextMarkerLayout = JSON.stringify(
        branchMarkers.map((marker) => [marker.id, marker.text, marker.screenBounds]),
      );
      if (nextMarkerLayout !== markerLayout) {
        markerLayout = nextMarkerLayout;
        mapSurface?.refresh();
      }
      const percentage = Math.round(state.view.zoom * 100);
      syncingZoom = true;
      const sliderValue = Math.max(10, Math.min(400, percentage));
      if (sliderValue !== syncedZoomValue) {
        syncedZoomValue = sliderValue;
        zoomSlider.setProperty('value', sliderValue);
        zoomLabel.text = `Zoom ${percentage}%`;
      }
      syncingZoom = false;
    }
    zoomSlider.on(Message.VALUE_CHANGED, () => {
      if (syncingZoom) return;
      const percentage = Number(zoomSlider.getProperty('value'));
      if (!Number.isFinite(percentage) || percentage === syncedZoomValue) return;
      syncedZoomValue = percentage;
      canvas.zoomAt(Math.max(0.1, Math.min(4, percentage / 100)));
      zoomLabel.text = `Zoom ${Math.round(percentage)}%`;
      void syncZoom();
    });
    let previousTopicClick = null;
    let pointerRevision = null;
    let finishingEdit = false;
    canvas.find('object-canvas-surface').on(Message.POINTER, (event) => {
      if (event.detail.kind === 'down') {
        title.setProperty('focused', false);
        finishingEdit = Boolean(canvas.find('object-text-editor'));
        if (finishingEdit) canvas.endEdit(true);
        pointerRevision = model.revision;
        sidebarToggle.setProperty('focused', false);
        return;
      }
      void syncZoom();
      if (event.detail.kind !== 'up') return;
      const topic = current();
      const now = Date.now();
      if (finishingEdit || !topic || pointerRevision !== model.revision) {
        previousTopicClick = null;
        return;
      }
      if (
        previousTopicClick?.id === topic.id &&
        previousTopicClick.revision === model.revision &&
        now - previousTopicClick.time <= 500
      ) {
        previousTopicClick = null;
        toggleBranch(topic);
        return;
      }
      previousTopicClick = { id: topic.id, revision: model.revision, time: now };
    });
    canvas.find('object-canvas-surface').on(Message.KEY, (event) => {
      const detail = event.detail;
      if (detail.pressed === false || detail.modifiers & (4 | 8 | 64)) return;
      if (!current() || canvas.find('object-text-editor')) return;
      const text = detail.text || (Array.from(detail.key || '').length === 1 ? detail.key : '');
      const printable =
        (detail.keyCode >= 10 && detail.keyCode <= 21) ||
        (detail.keyCode >= 24 && detail.keyCode <= 35) ||
        (detail.keyCode >= 38 && detail.keyCode <= 49) ||
        (detail.keyCode >= 51 && detail.keyCode <= 61);
      if (!text && !printable) return;
      previousTopicClick = null;
      if (!canvas.beginEdit(current().id)) return;
      if (text) {
        const input = canvas.find('object-text-editor');
        input.setProperty('value', `${input.getProperty('value')}${text}`);
        input.setSelection(Array.from(input.getProperty('value')).length);
      }
    });
    canvas.on(Message.KEY, safe(syncZoom));
    canvas.on(Message.SIZE_CHANGED, safe(syncZoom));
    function fitMap() {
      canvas.fit();
      void syncZoom();
    }
    let filterTags = [];
    let searchMatches = [];
    let searchIndex = -1;
    let tagSignature = '';
    const search = new TextField({
      value: '',
      name: 'topic-search',
      accessibleName: 'Search topics',
    });
    const searchCount = new Label({ text: '' });
    const tagFilters = new ChipGroup({
      items: [],
      width: 240,
      height: 36,
      multiple: true,
      onChange(ids) {
        filterTags = [...ids, ...filterTags.filter((id) => secondTagIds.has(id))];
        applyFilters();
        refreshSearch();
        fitMap();
      },
    });
    let secondTagIds = new Set();
    const moreTagFilters = new ChipGroup({
      items: [],
      multiple: true,
      onChange(ids) {
        filterTags = [...filterTags.filter((id) => !secondTagIds.has(id)), ...ids];
        applyFilters();
        refreshSearch();
        fitMap();
      },
    });
    function matchesTags(object) {
      return !filterTags.length || filterTags.some((id) => (object.tags || []).includes(id));
    }
    function applyFilters() {
      canvas.setFilter(matchesTags);
      if (filterTags.length) {
        const ancestors = new Set();
        for (const topic of model.value.objects.filter(matchesTags)) {
          let parent = topic.parent;
          while (parent && !ancestors.has(parent)) {
            ancestors.add(parent);
            parent = model.value.objects.find((object) => object.id === parent)?.parent;
          }
        }
        if (model.value.objects.some((object) => ancestors.has(object.id) && object.collapsed)) {
          model.transact('Reveal filtered topics', (draft) => {
            for (const object of draft.objects) {
              if (ancestors.has(object.id)) object.collapsed = false;
            }
          });
        }
      }
      void syncZoom();
    }
    function refreshFilterTags() {
      const signature = JSON.stringify(model.value.tags);
      if (signature === tagSignature) return;
      tagSignature = signature;
      filterTags = filterTags.filter((id) => model.value.tags.some((tag) => tag.id === id));
      const items = model.value.tags.map((tag) => ({
        id: tag.id,
        label: tag.label,
        color: tag.color,
        width: Math.max(44, tag.label.length * 10 + 30),
      }));
      const middle = Math.ceil(items.length / 2);
      secondTagIds = new Set(items.slice(middle).map((tag) => tag.id));
      tagFilters.setItems(items.slice(0, middle));
      moreTagFilters.setItems(items.slice(middle));
      tagFilters.setValue(filterTags.filter((id) => !secondTagIds.has(id)));
      moreTagFilters.setValue(filterTags.filter((id) => secondTagIds.has(id)));
      for (const row of filterRows) row.refresh();
    }
    function refreshSearch(selectMatches = true) {
      const query = search.getProperty('value').trim().toLocaleLowerCase();
      searchMatches = query
        ? model.value.objects.filter(
            (object) =>
              matchesTags(object) && (object.text || '').toLocaleLowerCase().includes(query),
          )
        : [];
      searchIndex = -1;
      searchCount.text = query
        ? `${searchMatches.length} matching topic${searchMatches.length === 1 ? '' : 's'}`
        : '';
      if (query) status.text = searchCount.getProperty('text');
      if (query && selectMatches) {
        const matchingIds = searchMatches.map((object) => object.id);
        const ancestorIds = revealAncestors(matchingIds);
        views.select('map');
        canvas.select(matchingIds);
        if (matchingIds.length) canvas.fit([...matchingIds, ...ancestorIds]);
        void syncZoom();
      }
    }
    function revealAncestors(ids) {
      const ancestors = new Set();
      for (const id of ids) {
        let parent = model.value.objects.find((object) => object.id === id)?.parent;
        while (parent && !ancestors.has(parent)) {
          ancestors.add(parent);
          parent = model.value.objects.find((object) => object.id === parent)?.parent;
        }
      }
      if (!model.value.objects.some((object) => ancestors.has(object.id) && object.collapsed)) {
        return [...ancestors];
      }
      model.transact('Reveal matching topics', (draft) => {
        for (const object of draft.objects) {
          if (ancestors.has(object.id)) object.collapsed = false;
        }
      });
      return [...ancestors];
    }
    async function revealTopic(id) {
      const topic = model.value.objects.find((object) => object.id === id);
      if (!topic) return;
      if (!matchesTags(topic)) {
        filterTags = [];
        tagFilters.setValue([]);
        moreTagFilters.setValue([]);
        applyFilters();
      }
      revealAncestors([id]);
      showDetails = false;
      content.refresh();
      views.select('map');
      canvas.select([id]);
      await canvas.inspect({ start: 0, limit: 1 });
      canvas.fit([id]);
      void syncZoom();
      status.text = `Selected: ${topic.text || 'Untitled'}`;
    }
    async function nextMatch() {
      if (!searchMatches.length) return;
      searchIndex = (searchIndex + 1) % searchMatches.length;
      const topic = searchMatches[searchIndex];
      await revealTopic(topic.id);
      searchCount.text = `${searchIndex + 1} of ${searchMatches.length}: ${topic.text || 'Untitled'}`;
      status.text = searchCount.getProperty('text');
    }
    search.on(Message.VALUE_CHANGED, refreshSearch);
    const nextResult = new IconButton({
      icon: Icons.GoForward,
      title: 'Next result',
      name: 'next-result',
    });
    nextResult.on(Message.ACTIVATE, safe(nextMatch));
    const clearSearch = new IconButton({
      icon: Icons.Close,
      title: 'Clear search',
      name: 'clear-search',
    });
    clearSearch.on(Message.ACTIVATE, () => {
      search.setProperty('value', '');
      refreshSearch();
      status.text = 'Search cleared';
      canvas.select([selected].filter(Boolean));
      search.setProperty('focused', true);
    });
    const clearFilters = new Button({
      text: 'Show all tags',
      state: State.ENABLED | State.START_ALIGNED,
    });
    clearFilters.on(Message.ACTIVATE, () => {
      filterTags = [];
      tagFilters.setValue([]);
      moreTagFilters.setValue([]);
      applyFilters();
      refreshSearch();
      fitMap();
      for (const row of filterRows) row.refresh();
    });
    function collapseAll(collapsed) {
      const parents = new Set(model.value.objects.map((object) => object.parent).filter(Boolean));
      model.transact(collapsed ? 'Collapse all' : 'Expand all', (draft) => {
        for (const object of draft.objects) {
          if (parents.has(object.id)) object.collapsed = collapsed;
        }
      });
      fitMap();
    }
    function refreshOutline() {
      const entries = [];
      function collect(parent, depth) {
        for (const object of model.value.objects.filter(
          (item) => (item.parent || null) === parent,
        )) {
          entries.push({
            id: object.id,
            text: `${'  '.repeat(Math.min(depth, 12))}${depth ? '↳ ' : ''}${object.text || 'Untitled'}`,
          });
          collect(object.id, depth + 1);
        }
      }
      collect(null, 0);
      if (
        entries.length &&
        entries.length === outlineControls.length &&
        entries.every((entry, index) => outlineControls[index].topicId === entry.id)
      ) {
        entries.forEach((entry, index) => {
          if (outlineControls[index].getProperty('text') !== entry.text) {
            outlineControls[index].setProperty('text', entry.text);
          }
        });
        return;
      }
      for (const control of outlineControls) {
        outline.remove(control);
        control.destroy();
      }
      outlineControls = [];
      function visit(parent, depth) {
        for (const object of model.value.objects.filter(
          (item) => (item.parent || null) === parent,
        )) {
          const button = new Button({
            text: `${'  '.repeat(Math.min(depth, 12))}${depth ? '↳ ' : ''}${object.text || 'Untitled'}`,
          });
          button.topicId = object.id;
          button.on(
            Message.ACTIVATE,
            safe(() => revealTopic(object.id)),
          );
          outline.append(button);
          outlineControls.push(button);
          visit(object.id, depth + 1);
        }
      }
      visit(null, 0);
      if (!model.value.objects.length) {
        const empty = new Label({ text: 'No topics. Add a topic to begin.' });
        outline.append(empty);
        outlineControls.push(empty);
      }
    }
    function commitHierarchy(label, mutate) {
      model.transact(label, (draft) => {
        mutate(draft);
        const objects = new Map(draft.objects.map((topic) => [topic.id, topic]));
        for (const topic of draft.objects) {
          const visited = new Set([topic.id]);
          let parent = topic.parent;
          while (parent) {
            if (!objects.has(parent)) throw new Error(`Unknown parent: ${parent}`);
            if (visited.has(parent))
              throw new Error('A topic cannot parent itself or an ancestor.');
            visited.add(parent);
            if (visited.size > 32) throw new Error('Maximum hierarchy depth is 32 layers.');
            parent = objects.get(parent).parent;
          }
        }
        if (draft.objects.length > 1000) throw new Error('Maximum map size is 1000 topics.');
        const geometry = layoutObjects(draft.objects, {
          type: 'tree',
          direction: 'right',
          gap: 60,
          connections: draft.connections,
        });
        draft.objects = geometry;
      });
      fitMap();
    }
    function topicText(text) {
      if (typeof text !== 'string' || !text.trim() || text.length > 1000) {
        throw new Error('Topic text must contain 1–1000 characters.');
      }
      return text.trim();
    }
    function parentLink(parent, id) {
      return {
        id: `link-${++serial}`,
        source: parent,
        target: id,
        routing: connectorStyle(),
        sourcePort: 'right',
        targetPort: 'left',
      };
    }
    function createHierarchy({ topics }) {
      const ids = topics.map((topic) => topic.id);
      if (!topics.length || topics.length > 128 || new Set(ids).size !== ids.length) {
        throw new Error('Supply 1–128 topics with unique IDs.');
      }
      const existing = new Set(model.value.objects.map((topic) => topic.id));
      const additions = topics.map((topic) => {
        if (!topic.id || existing.has(topic.id)) throw new Error(`Duplicate topic ID: ${topic.id}`);
        return {
          id: topic.id,
          text: topicText(topic.text),
          ...(topic.parentId ? { parent: topic.parentId } : {}),
          x: 0,
          y: 0,
          width: 190,
          height: 64,
          shape: 'roundedRect',
          droppable: true,
        };
      });
      commitHierarchy('Create hierarchy', (draft) => {
        draft.objects.push(...additions);
        for (const topic of additions) {
          if (topic.parent) draft.connections.push(parentLink(topic.parent, topic.id));
        }
      });
      canvas.select([ids[0]]);
      return { ids };
    }
    function removeTopic({ id }) {
      if (!model.value.objects.some((topic) => topic.id === id))
        throw new Error(`Unknown topic: ${id}`);
      const removed = new Set([id]);
      let size;
      do {
        size = removed.size;
        for (const topic of model.value.objects) {
          if (removed.has(topic.parent)) removed.add(topic.id);
        }
      } while (size !== removed.size);
      commitHierarchy('Remove topic subtree', (draft) => {
        draft.objects = draft.objects.filter((topic) => !removed.has(topic.id));
        draft.connections = draft.connections.filter(
          (link) => !removed.has(link.source) && !removed.has(link.target),
        );
      });
      canvas.select([]);
      return { ids: [...removed] };
    }
    function reparentTopic({ id, parentId }) {
      const topic = model.value.objects.find((item) => item.id === id);
      if (!topic) throw new Error(`Unknown topic: ${id}`);
      commitHierarchy('Reparent topic', (draft) => {
        const changed = draft.objects.find((item) => item.id === id);
        draft.connections = draft.connections.filter(
          (link) => !(link.source === changed.parent && link.target === id),
        );
        if (parentId) {
          changed.parent = parentId;
          draft.connections.push(parentLink(parentId, id));
        } else {
          delete changed.parent;
        }
      });
      return { ids: [id] };
    }
    function addTopic(data = {}) {
      const parent = current();
      const id = `topic-${++serial}`;
      return createHierarchy({
        topics: [
          {
            id,
            text: data.text ?? 'New topic',
            parentId: Object.hasOwn(data, 'parentId') ? data.parentId : parent?.id,
          },
        ],
      });
    }
    async function save() {
      if (!file) {
        const chosen = await services.files.saveDialog({
          suggestedName: 'mind-map.json',
          filters: ['application/json'],
        });
        file = Array.isArray(chosen) ? chosen[0] : chosen;
      }
      if (file) {
        if (file.path) {
          const revision = model.revision;
          const data = new TextEncoder().encode(serializeVisualDocument(model.value));
          await services.files.write({ path: file.path, data, requireDurable: true });
          if (revision === model.revision) model.markSaved();
        } else {
          await session.save({ file });
        }
        status.text = 'Map saved';
      }
    }
    function svg() {
      const escape = (text) =>
        String(text).replace(
          /[&<>"']/g,
          (character) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character],
        );
      const objects = model.value.objects;
      const left = Math.min(0, ...objects.map((object) => object.x)) - 30;
      const top = Math.min(0, ...objects.map((object) => object.y)) - 30;
      const width = Math.max(100, ...objects.map((object) => object.x + object.width)) - left + 30;
      const height = Math.max(100, ...objects.map((object) => object.y + object.height)) - top + 30;
      const links = model.value.connections
        .map((link) => {
          const source = objects.find((object) => object.id === link.source);
          const target = objects.find((object) => object.id === link.target);
          return source && target
            ? `<path d="M ${source.x + source.width} ${source.y + source.height / 2} L ${target.x} ${target.y + target.height / 2}" stroke="#64748B" stroke-width="2"/>`
            : '';
        })
        .join('');
      const shapes = objects
        .map(
          (object) =>
            `<g><rect x="${object.x}" y="${object.y}" width="${object.width}" height="${object.height}" rx="12" fill="${escape(object.style?.fill || '#F1F5F9')}" stroke="#64748B"/><text x="${object.x + 12}" y="${object.y + 30}" font-family="sans-serif" font-size="14" fill="#172033">${escape(object.text || '')}</text></g>`,
        )
        .join('');
      return new TextEncoder().encode(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${width} ${height}" width="${width}" height="${height}">${links}${shapes}</svg>`,
      );
    }
    async function exportMap(format) {
      if (!model.value.objects.length) throw new Error('Add a topic before exporting.');
      const output =
        format === 'svg'
          ? { bytes: svg(), mime: 'image/svg+xml' }
          : await exportVisualPresentation({ document: model.value, services, format: 'pptx' });
      const result = await handoff.exportAndOpen({
        data: output.bytes,
        name: `mind-map.${format}`,
        mimeType: output.mime,
        file: { path: `mind-map.${format}` },
      });
      status.text = result.cancelled ? 'Export cancelled' : 'Export saved; system open requested';
    }
    const connectorOptions = [
      { id: 'curve', label: 'Bézier', icon: Icons.Line },
      { id: 'orthogonal', label: 'Angled', icon: Icons.DrawPolyline },
      { id: 'straight', label: 'Straight', icon: Icons.Line },
    ];
    function connectorStyle() {
      return (
        model.value.metadata?.connectorStyle || model.value.connections[0]?.routing || 'orthogonal'
      );
    }
    function setConnectorStyle(routing) {
      model.transact('Change connector style', (draft) => {
        draft.metadata = { ...draft.metadata, connectorStyle: routing };
        for (const link of draft.connections) {
          link.routing = routing;
          link.sourcePort = 'right';
          link.targetPort = 'left';
        }
      });
      status.text = `Connector style: ${connectorOptions.find((option) => option.id === routing).label}`;
    }
    const commands = new CommandRegistry([
      ...connectorOptions.map((option) => ({
        id: `connector-${option.id}`,
        label: option.label,
        icon: option.icon,
        checked: connectorStyle() === option.id,
        run: () => setConnectorStyle(option.id),
      })),
      { id: 'add-topic', label: 'Add topic', icon: Icons.ObjectAdd, run: addTopic },
      { id: 'create-hierarchy', label: 'Create hierarchy', run: createHierarchy },
      { id: 'remove-topic', label: 'Remove subtree', run: removeTopic },
      { id: 'reparent-topic', label: 'Reparent topic', run: reparentTopic },
      {
        id: 'get-map',
        label: 'Read map',
        run: () => ({
          topics: model.value.objects.map((topic) => ({
            id: topic.id,
            text: topic.text || '',
            parentId: topic.parent || '',
          })),
        }),
      },
      { id: 'undo', label: 'Undo', icon: Icons.EditUndo, run: () => model.undo() },
      { id: 'redo', label: 'Redo', icon: Icons.EditRedo, run: () => model.redo() },
      { id: 'fit', label: 'Fit map', icon: Icons.Fullscreen, run: fitMap },
      { id: 'collapse-all', label: 'Collapse all', run: () => collapseAll(true) },
      { id: 'expand-all', label: 'Expand all', run: () => collapseAll(false) },
      {
        id: 'delete',
        label: 'Delete topic',
        icon: Icons.EditDelete,
        run: () => {
          if (selected) return removeTopic({ id: selected });
        },
      },
      {
        id: 'collapse',
        label: 'Collapse / expand',
        icon: 73,
        run: () => {
          toggleBranch(current());
        },
      },
      {
        id: 'tree',
        label: 'Tree',
        icon: Icons.ChartHierarchy,
        run: () => {
          canvas.setLayout({ type: 'tree', direction: 'right', gap: 60 });
          fitMap();
        },
      },
      {
        id: 'grid',
        label: 'Grid',
        icon: Icons.ViewGrid,
        run: () => {
          canvas.setLayout({ type: 'grid', gap: 60 });
          fitMap();
        },
      },
      {
        id: 'hierarchy',
        label: 'Hierarchy',
        icon: Icons.ChartHierarchy,
        run: () => {
          canvas.setLayout({ type: 'hierarchical', direction: 'down', gap: 60 });
          fitMap();
        },
      },
      { id: 'save', label: 'Save', icon: Icons.DocumentSave, run: safe(save) },
      {
        id: 'reopen',
        label: 'Reopen saved map',
        run: safe(async () => {
          const data = await services.files.read({ path: 'mind-map.json' });
          model.replace(parseVisualDocument(new TextDecoder().decode(data)));
          file = { path: 'mind-map.json' };
          canvas.select([model.value.objects[0]?.id].filter(Boolean));
          fitMap();
          status.text = 'Saved map reopened';
        }),
      },
      {
        id: 'save-as',
        label: 'Save as…',
        run: safe(async () => {
          file = null;
          await save();
        }),
      },
      {
        id: 'open',
        label: 'Open…',
        run: safe(async () => {
          const chosen = await services.files.openDialog({ filters: ['application/json'] });
          const opened = Array.isArray(chosen) ? chosen[0] : chosen;
          if (opened) {
            await session.open(opened);
            file = opened;
            fitMap();
          }
        }),
      },
      {
        id: 'new',
        label: 'New map',
        icon: Icons.DocumentNew,
        run: () => {
          model.transact('New map', (draft) => {
            draft.objects = [
              {
                id: 'start',
                text: 'Start',
                x: 80,
                y: 80,
                width: 190,
                height: 64,
                shape: 'roundedRect',
                droppable: true,
              },
            ];
            draft.connections = [];
            draft.tags = [];
          });
          file = { path: 'mind-map.json' };
          canvas.select(['start']);
          fitMap();
          status.text = 'New map';
        },
      },
      { id: 'svg', label: 'Export SVG…', run: safe(() => exportMap('svg')) },
      { id: 'deck', label: 'Export to Rice Deck…', run: safe(() => exportMap('pptx')) },
    ]);
    function commandGroup(ids) {
      const labels = {
        'add-topic': 'Delete topic',
        delete: 'Delete topic',
        fit: 'Collapse / expand',
        collapse: 'Collapse / expand',
        undo: 'Undo',
        redo: 'Undo',
        tree: 'Hierarchy',
        hierarchy: 'Hierarchy',
        grid: 'Hierarchy',
        'connector-curve': 'Hierarchy',
        'connector-orthogonal': 'Hierarchy',
        'connector-straight': 'Hierarchy',
      };
      return ids.map((id) => {
        const button = commands.button(id, { state: State.ENABLED | State.START_ALIGNED });
        if (!labels[id]) return button;
        return new Workspace({
          text: `${labels[id]}     `,
          render(view) {
            if (view.width < 1 || view.height < 1) return;
            const arranged =
              ['tree', 'hierarchy', 'grid'].includes(id) || id.startsWith('connector-');
            const buttonWidth = arranged ? Math.min(153, view.width) : view.width;
            view.place(id, button, [0, 0, buttonWidth, view.height]);
          },
        });
      });
    }
    const branchActions = ['collapse-all', 'expand-all'].map((id) => {
      const button = commands.button(id);
      return new Workspace({
        text: 'Collapse all',
        render(view) {
          if (view.width < 1 || view.height < 1) return;
          view.place(id, button, [0, 0, view.width, view.height]);
        },
      });
    });
    const searchTools = new Workspace({
      text: 'Search topics and navigate results',
      width: 360,
      height: 76,
      render(view) {
        if (view.width < 200 || view.height < 1) return;
        view.place('query', search, [0, 0, Math.max(120, view.width - 80), 36]);
        view.place('next', nextResult, [view.width - 76, 0, 36, 36]);
        view.place('clear', clearSearch, [view.width - 36, 0, 36, 36]);
      },
    });
    const filterChips = new Map();
    const filterRows = [0, 1].map(
      (rowIndex) =>
        new Workspace({
          text: 'Filter matching topics by selecting one or more topic tags',
          render(view) {
            if (view.width < 36 || view.height < 1) return;
            const middle = Math.ceil(model.value.tags.length / 2);
            const tags =
              rowIndex === 0 ? model.value.tags.slice(0, middle) : model.value.tags.slice(middle);
            let left = 0;
            for (const tag of tags) {
              const chipKey = `${rowIndex}:${tag.id}`;
              let chip = filterChips.get(chipKey);
              if (!chip) {
                chip = new Chip({
                  text: tag.label,
                  color: tag.color,
                  accessibleName: `Filter tag ${tag.label}`,
                });
                chip.on(Message.ACTIVATE, () => {
                  filterTags = filterTags.includes(tag.id)
                    ? filterTags.filter((id) => id !== tag.id)
                    : [...filterTags, tag.id];
                  applyFilters();
                  refreshSearch();
                  fitMap();
                  for (const row of filterRows) row.refresh();
                });
                filterChips.set(chipKey, chip);
              }
              chip.setProperty('selected', filterTags.includes(tag.id));
              const width = Math.max(44, tag.label.length * 10 + 30);
              if (left + width > view.width) break;
              view.place(tag.id, chip, [left, 0, width, Math.min(36, view.height)]);
              left += width + 6;
            }
          },
        }),
    );
    const ribbon = new Ribbon({
      presentation: 'office',
      controlHeight: 36,
      tabs: [
        {
          id: 'home',
          title: 'Home',
          groups: [
            {
              id: 'topics',
              title: 'Topics',
              primary: 0,
              minWidth: 180,
              controls: commandGroup(['add-topic', 'delete']),
            },
            {
              id: 'edit',
              title: 'History',
              primary: 0,
              minWidth: 180,
              controls: commandGroup(['undo', 'redo']),
            },
            {
              id: 'branches',
              title: 'Branches',
              primary: 0,
              minWidth: 180,
              controls: branchActions,
            },
            {
              id: 'navigate',
              title: 'Navigate',
              primary: 0,
              minWidth: 180,
              controls: commandGroup(['fit', 'collapse']),
            },
          ],
        },
        {
          id: 'arrange',
          title: 'Arrange',
          groups: [
            {
              id: 'layout',
              title: 'Layout',
              primary: 0,
              minWidth: 180,
              controls: commandGroup(['tree', 'hierarchy', 'grid']),
            },
            {
              id: 'connectors',
              title: 'Connector style',
              primary: 0,
              minWidth: 180,
              controls: commandGroup(connectorOptions.map((option) => `connector-${option.id}`)),
            },
          ],
        },
        {
          id: 'find',
          title: 'Find',
          groups: [
            {
              id: 'search',
              title: 'Search topics',
              primary: 1,
              minWidth: 456,
              controls: [searchTools],
            },
            {
              id: 'tags',
              title: 'Filter tags',
              primary: 0,
              minWidth: 240,
              controls: filterRows,
            },
            {
              id: 'reset-tags',
              title: 'Reset',
              controls: [clearFilters],
            },
          ],
        },
      ],
    });
    const saveIcon = new IconButton({
      icon: Icons.DocumentSave,
      title: 'Save map',
      name: 'quick-save',
    });
    saveIcon.on(Message.ACTIVATE, () => commands.execute('save'));
    const newIcon = new IconButton({
      icon: Icons.DocumentNew,
      title: 'Create new map',
      name: 'quick-new',
    });
    newIcon.on(Message.ACTIVATE, () => commands.execute('new'));
    let sidebarVisible = true;
    const sidebarToggle = new Button({
      text: 'Hide sidebar',
      name: 'toggle-sidebar',
      accessibleName: 'Hide topic sidebar',
    });
    sidebarToggle.on(Message.ACTIVATE, () => {
      sidebarVisible = !sidebarVisible;
      showDetails = sidebarVisible;
      sidebarToggle.setProperty('text', sidebarVisible ? 'Hide sidebar' : 'Show sidebar');
      sidebarToggle.setProperty(
        'accessibleName',
        sidebarVisible ? 'Hide topic sidebar' : 'Show topic sidebar',
      );
      content.refresh();
      void syncZoom();
    });
    title.on(Message.POINTER, (event) => {
      if (event.detail.kind === 'down') {
        sidebarToggle.setProperty('focused', false);
        title.setProperty('focused', true);
      }
    });
    ribbon.setHeader({
      leading: [
        commands.menuBar([
          {
            label: 'File',
            items: ['new', 'open', 'reopen', 'save', 'save-as', null, 'svg', 'deck'],
          },
        ]),
      ],
      trailing: [new ToolBar({}, [saveIcon, newIcon]), sidebarToggle],
    });
    const swatches = [
      { id: '#DBEAFE', label: 'Blue', color: '#DBEAFE' },
      { id: '#DCFCE7', label: 'Green', color: '#DCFCE7' },
      { id: '#FEF3C7', label: 'Amber', color: '#FEF3C7' },
      { id: '#FCE7F3', label: 'Rose', color: '#FCE7F3' },
      { id: '#EDE9FE', label: 'Violet', color: '#EDE9FE' },
      { id: '#CFFAFE', label: 'Cyan', color: '#CFFAFE' },
      { id: '#FFEDD5', label: 'Peach', color: '#FFEDD5' },
      { id: '#E2E8F0', label: 'Slate', color: '#E2E8F0' },
    ];
    function applyColor(fill) {
      if (!current()) {
        status.text = 'Select a topic first.';
        return;
      }
      const channels = [1, 3, 5].map((offset) => parseInt(fill.slice(offset, offset + 2), 16));
      const brightness = channels[0] * 0.299 + channels[1] * 0.587 + channels[2] * 0.114;
      model.updateObjects([selected], {
        style: { ...current().style, fill, foreground: brightness < 145 ? '#FFFFFF' : '#172033' },
      });
      status.text = `Topic color ${fill}`;
    }
    let pickingColor = false;
    let editingTags = false;
    const editTags = new Button({ text: 'Edit tags…' });
    editTags.on(Message.ACTIVATE, () => {
      editingTags = true;
      details.refresh();
      tagDraft.setProperty('focused', true);
    });
    const colorPicker = new ColorPalette({
      value: '#DBEAFE',
      standardColors: [],
      moreColors: true,
      onCommit(fill) {
        if (typeof fill === 'string' && /^#[0-9a-f]{6}$/i.test(fill)) {
          applyColor(fill);
        }
      },
    });
    const colorApply = new Button({ text: 'Choose color…' });
    colorApply.on(Message.ACTIVATE, () => {
      pickingColor = true;
      details.refresh();
    });
    const palette = new ChipGroup({
      multiple: false,
      items: swatches.map((item) => ({ ...item, width: 84, id: `color-${item.id.slice(1)}` })),
      onChange(ids) {
        if (ids[0]) applyColor(`#${ids[0].slice(6)}`);
      },
    });
    const details = new Workspace({
      width: 320,
      height: 550,
      render(view) {
        const width = Math.min(600, view.width - 32);
        if (!current() && !editingTags && !pickingColor) {
          view.label('select-topic', 'Select a topic to edit', [16, 16, width, 28]);
          return;
        }
        if (editingTags) {
          view.action('back-tags', 'Back to topic', [16, 12, 180, 36], () => {
            editingTags = false;
            details.refresh();
            editTags.setProperty('focused', true);
          });
          view.label('tags-label', 'Tags (comma separated)', [16, 64, width, 24]);
          view.place('tag-draft', tagDraft, [16, 96, width, 36]);
          view.place('add-tag', addTag, [16, 140, 112, 36]);
          view.label('delete-tags-label', 'Click a tag to delete', [16, 184, width, 24]);
          view.place('tag-list', tagHost, [16, 216, width, Math.max(100, view.height - 232)]);
          return;
        }
        if (pickingColor) {
          view.action('back-colors', 'Back to topic', [16, 12, 180, 36], () => {
            pickingColor = false;
            details.refresh();
            colorApply.setProperty('focused', true);
          });
          view.place('color-picker', colorPicker, [16, 60, width, 460]);
          return;
        }
        view.label('title-label', 'Topic title', [16, 16, width, 24]);
        view.place('title', title, [16, 44, width, 36]);
        view.label('color-label', 'Color', [16, 96, width, 24]);
        view.place('palette', palette, [16, 124, width, 132]);
        view.place('choose-color', colorApply, [16, 260, width, 36]);
        view.place('edit-tags', editTags, [16, 308, width, 36]);
      },
    });
    mapSurface = new Workspace({
      width: 760,
      height: 460,
      state: State.ENABLED | State.EXPANSIVE,
      render(view) {
        view.place('canvas', canvas, [0, 0, view.width, view.height]);
        for (const marker of branchMarkers) {
          if (!markerVisible(marker.id)) continue;
          const bounds = marker.screenBounds;
          if (
            bounds.x + bounds.width < 0 ||
            bounds.y + bounds.height < 0 ||
            bounds.x > view.width ||
            bounds.y > view.height
          )
            continue;
          let expand = expandButtons.get(marker.id);
          if (!expand) {
            expand = new Button({ text: '+', name: `expand-${marker.id}` }, [
              new Tooltip({ text: `Expand ${marker.text || 'topic'} children` }),
            ]);
            expand.on(Message.ACTIVATE, () => {
              const topic = model.value.objects.find((item) => item.id === marker.id);
              if (!topic?.collapsed) return;
              model.setCollapsed(topic.id, false);
              canvas.select([topic.id]);
              canvas.find('object-canvas-surface').setProperty('focused', true);
              void syncZoom();
            });
            expandButtons.set(marker.id, expand);
          }
          expand.setProperty('accessibleName', `Expand ${marker.text || 'topic'} children`);
          view.place(`expand-${marker.id}`, expand, [
            Math.max(0, Math.min(view.width - 36, bounds.x + bounds.width + 8)),
            Math.max(0, Math.min(view.height - 36, bounds.y + bounds.height / 2 - 18)),
            36,
            36,
          ]);
        }
      },
    });
    const views = new TabView({
      state: State.ENABLED | State.EXPANSIVE,
      pages: [
        new TabPage({ id: 'map', title: 'Map' }, [mapSurface]),
        new TabPage({ id: 'outline', title: 'Outline' }, [new ScrollView({}, [outline])]),
      ],
    });
    views.on(Message.SELECT, () => {
      if (views.value === 'outline') refreshOutline();
    });
    let showDetails = false;
    const inspector = new ScrollView({}, [details]);
    const footer = new Workspace({
      width: 1100,
      height: 32,
      render(view) {
        view.place('status', status, [8, 2, Math.max(120, view.width - 344), 28]);
        view.place('zoom-label', zoomLabel, [view.width - 324, 2, 108, 28]);
        view.place('zoom-slider', zoomSlider, [view.width - 208, 0, 196, 32]);
      },
    });
    const content = new Workspace({
      width: 1100,
      height: 530,
      state: State.ENABLED | State.EXPANSIVE,
      render(view) {
        view.place('zoom-footer', footer, [0, view.height - 32, view.width, 32]);
        if (view.width >= 850) {
          view.place('views', views, [
            0,
            0,
            sidebarVisible ? view.width - 332 : view.width,
            view.height - 32,
          ]);
          if (sidebarVisible) {
            view.place('inspector', inspector, [view.width - 324, 0, 324, view.height - 32]);
          }
        } else {
          view.action(
            'toggle',
            showDetails ? 'Back to map' : 'Topic details',
            [12, 4, 160, 36],
            () => {
              showDetails = !showDetails;
              content.refresh();
            },
          );
          view.place(showDetails ? 'inspector' : 'views', showDetails ? inspector : views, [
            0,
            48,
            view.width,
            view.height - 80,
          ]);
        }
      },
    });
    const geometryKey = () =>
      JSON.stringify(
        model.value.objects.map((object) => [
          object.id,
          object.parent,
          object.collapsed,
          object.x,
          object.y,
          object.width,
          object.height,
          object.rotation,
        ]),
      );
    let previousGeometry = geometryKey();
    model.subscribe(() => {
      for (const option of connectorOptions) {
        commands.update(`connector-${option.id}`, { checked: connectorStyle() === option.id });
      }
      refreshFilterTags();
      refreshTags();
      if (editingTags) details.refresh();
      if (search.getProperty('value').trim()) refreshSearch(false);
      if (!title.getProperty('focused')) {
        title.setProperty('value', current()?.text || '');
      }
      if (views.value === 'outline') refreshOutline();
      const nextGeometry = geometryKey();
      if (nextGeometry !== previousGeometry) {
        previousGeometry = nextGeometry;
        mapSurface.refresh();
        void syncZoom();
      }
      const data = new TextEncoder().encode(serializeVisualDocument(model.value));
      recovery = recovery
        .catch(() => {})
        .then(() => services.files.write({ path: 'recovery.json', data, requireDurable: true }))
        .catch((error) => {
          status.text = `Recovery failed: ${error.message}`;
        });
    });
    refreshOutline();
    refreshFilterTags();
    const root = new Column({ text: 'panel:fixed:padding=0:gap=0' }, [ribbon, content]);
    const completionControls = new WeakSet();
    function bindOutsideCompletion(control) {
      if (control === canvas) return;
      if (!completionControls.has(control)) {
        completionControls.add(control);
        control.on(Message.POINTER, (event) => {
          if (event.detail.kind !== 'down') return;
          canvas.endEdit(true);
          previousTopicClick = null;
          if (control === title) title.setProperty('value', current()?.text || '');
        });
        control.on(Message.CHILD_ADDED, () => bindOutsideCompletion(control));
      }
      for (const child of control.children) bindOutsideCompletion(child);
    }
    bindOutsideCompletion(root);
    const window = createWindow({ root });
    const registry = new AppCapabilityRegistry({ app, bus, services });
    await registry.bind({
      window,
      onAction: () => {
        showDetails = true;
        content.refresh();
      },
      context: async () => ({ revision: model.revision, ready: true, document: model.value }),
      commands,
      bindings: {
        'add-topic': 'add-topic',
        'create-hierarchy': 'create-hierarchy',
        'remove-topic': 'remove-topic',
        'reparent-topic': 'reparent-topic',
        'get-map': 'get-map',
      },
    });
    canvas.select([model.value.objects[0]?.id].filter(Boolean));
    fitMap();
  },
});
