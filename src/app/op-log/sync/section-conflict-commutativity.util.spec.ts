import { Action } from '@ngrx/store';
import { Project, ProjectState } from '../../features/project/project.model';
import { SectionState } from '../../features/section/section.model';
import {
  addSection,
  addTaskToSection,
  removeTaskFromSection,
} from '../../features/section/store/section.actions';
import {
  initialSectionState,
  sectionReducer,
} from '../../features/section/store/section.reducer';
import { TagState } from '../../features/tag/tag.model';
import { WorkContextType } from '../../features/work-context/work-context.model';
import { extractActionPayload, Operation } from '../core/operation.types';
import { PersistentAction } from '../core/persistent-action.interface';
import {
  areCommutingSectionOperations,
  projectSectionReplayAgainstState,
} from './section-conflict-commutativity.util';

const P = 'project-1';

const toOp = (action: PersistentAction): Operation => {
  const { type, meta, ...actionPayload } = action;
  return {
    id: `op-${type}`,
    actionType: type,
    opType: meta.opType,
    entityType: meta.entityType,
    entityId: meta.entityId ?? meta.entityIds![0],
    entityIds: meta.entityIds,
    payload: { actionPayload, entityChanges: [] },
    clientId: 'test',
    vectorClock: { test: 1 },
    timestamp: 1,
    schemaVersion: 1,
  } as Operation;
};

const toAction = (op: Operation): Action =>
  ({
    type: op.actionType,
    ...(extractActionPayload(op.payload) as Record<string, unknown>),
  }) as Action;

const apply = (state: SectionState, actions: Action[]): SectionState =>
  actions.reduce(sectionReducer, state);

const base = apply(
  initialSectionState,
  [
    ['s1', ['mover', 'stay']],
    ['s2', ['other', 'last']],
    ['s3', ['extra']],
  ].map(([id, taskIds]) =>
    addSection({
      section: {
        id: id as string,
        title: id as string,
        contextId: P,
        contextType: WorkContextType.PROJECT,
        taskIds: taskIds as string[],
      },
    }),
  ),
);

const tag: TagState = { ids: [], entities: {} } as unknown as TagState;
const project: ProjectState = {
  ids: [P],
  entities: {
    [P]: { id: P, taskIds: ['mover', 'stay', 'other', 'last', 'extra'] } as Project,
  },
} as unknown as ProjectState;

const lists = (state: SectionState): Record<string, string[]> =>
  Object.fromEntries(
    (state.ids as string[]).map((id) => [id, state.entities[id]!.taskIds]),
  );

/** The rejected op, reissued from the state it was rejected in. */
const reissue = (op: Operation, state: SectionState): Action[] => {
  const projection = projectSectionReplayAgainstState(op, {
    section: state,
    project,
    tag,
  });
  if (projection.kind === 'superseded') return [];
  if (projection.kind !== 'replay') throw new Error(projection.kind);
  return [toAction(projection.operation)];
};

const MOVE = addTaskToSection({
  sectionId: 's2',
  taskId: 'mover',
  afterTaskId: null,
  sourceSectionId: 's1',
}) as PersistentAction;

const removal = (taskId: string, sectionId: string): PersistentAction =>
  removeTaskFromSection({
    sectionId,
    taskId,
    workContextId: P,
    workContextType: WorkContextType.PROJECT,
    workContextAfterTaskId: null,
  }) as PersistentAction;

const placement = (
  taskId: string,
  sectionId: string,
  sourceSectionId: string | null,
  afterTaskId: string | null,
): PersistentAction =>
  addTaskToSection({
    sectionId,
    taskId,
    afterTaskId,
    sourceSectionId,
  }) as PersistentAction;

describe('section list writes of different tasks (#10969)', () => {
  const DIFFERENT_TASKS: { name: string; action: PersistentAction }[] = [
    { name: 'another task moved S3 → S1', action: placement('extra', 's1', 's3', null) },
    {
      name: 'another task moved to the top of S2',
      action: placement('extra', 's2', 's3', null),
    },
    {
      name: 'another task reordered within S2',
      action: placement('other', 's2', 's2', 'last'),
    },
    {
      name: 'another task reordered within S1',
      action: placement('stay', 's1', 's1', null),
    },
    {
      name: 'another task placed from no section',
      action: placement('new', 's2', null, null),
    },
    { name: 'another task removed from S1', action: removal('stay', 's1') },
    { name: 'another task removed from S2', action: removal('other', 's2') },
  ];

  DIFFERENT_TASKS.forEach(({ name, action }) => {
    const [move, edit] = [toOp(MOVE), toOp(action)];

    it(`a cross-section move commutes with ${name}`, () => {
      expect(areCommutingSectionOperations(move, edit)).toBe(true);
      expect(areCommutingSectionOperations(edit, move)).toBe(true);
    });

    it(`converges with ${name} when the editor syncs first`, () => {
      // The mover applies the accepted edit, then reissues its rejected move.
      const mover = apply(base, [MOVE, action]);
      const editor = apply(base, [action, ...reissue(move, mover)]);
      expect(lists(editor)).toEqual(lists(mover));
    });

    it(`converges with ${name} when the mover syncs first`, () => {
      const editor = apply(base, [action, MOVE]);
      const mover = apply(base, [MOVE, ...reissue(edit, editor)]);
      expect(lists(mover)).toEqual(lists(editor));
    });
  });

  const STOPS: { name: string; move: PersistentAction; action: PersistentAction }[] = [
    {
      name: 'the same task moved S1 → S3',
      move: MOVE,
      action: placement('mover', 's3', 's1', null),
    },
    {
      name: 'the same task reordered within S1',
      move: MOVE,
      action: placement('mover', 's1', 's1', 'stay'),
    },
    { name: 'the same task removed from S2', move: MOVE, action: removal('mover', 's2') },
    // The reissue repositions only the rejected op's task; the anchored task
    // would land elsewhere on each device.
    {
      name: 'another task placed after the moved task',
      move: MOVE,
      action: placement('extra', 's1', 's3', 'mover'),
    },
    {
      name: 'a reorder of the task the move is placed after',
      move: placement('mover', 's2', 's1', 'other'),
      action: placement('other', 's2', 's2', 'last'),
    },
  ];

  STOPS.forEach(({ name, move, action }) => {
    it(`keeps the stop against ${name}`, () => {
      expect(areCommutingSectionOperations(toOp(move), toOp(action))).toBe(false);
      expect(areCommutingSectionOperations(toOp(action), toOp(move))).toBe(false);
    });
  });
});
