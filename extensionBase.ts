import * as vscode from 'vscode';
import * as path from 'path';

import { CompositionState } from './src/state/compositionState';
import { EditorIdentity } from './src/editorIdentity';
import { Globals } from './src/globals';
import { Jump } from './src/jumps/jump';
import { ModeHandler } from './src/mode/modeHandler';
import { ModeHandlerMap } from './src/mode/modeHandlerMap';
import { Mode } from './src/mode/mode';
import { Notation } from './src/configuration/notation';
import { Logger } from './src/util/logger';
import { StatusBar } from './src/statusBar';
import { VSCodeContext } from './src/util/vscodeContext';
import { commandLine } from './src/cmd_line/commandLine';
import { configuration } from './src/configuration/configuration';
import { globalState } from './src/state/globalState';
import { taskQueue } from './src/taskQueue';
import { Register } from './src/register/register';
import { SpecialKeys } from './src/util/specialKeys';

let extensionContext: vscode.ExtensionContext;
let previousActiveEditorId: EditorIdentity | undefined = undefined;
let lastClosedModeHandler: ModeHandler | null = null;

interface ICodeKeybinding {
  after?: string[];
  commands?: { command: string; args: any[] }[];
}

export async function getAndUpdateModeHandler(
  forceSyncAndUpdate = false
): Promise<ModeHandler | undefined> {
  const activeTextEditor = vscode.window.activeTextEditor;
  if (activeTextEditor === undefined || activeTextEditor.document.isClosed) {
    return undefined;
  }

  const activeEditorId = EditorIdentity.fromEditor(activeTextEditor);

  let [curHandler, isNew] = await ModeHandlerMap.getOrCreate(activeEditorId);
  if (isNew) {
    extensionContext.subscriptions.push(curHandler);
  }

  curHandler.vimState.editor = activeTextEditor;

  if (
    forceSyncAndUpdate ||
    !previousActiveEditorId ||
    !previousActiveEditorId.isEqual(activeEditorId)
  ) {
    // We sync the cursors here because ModeHandler is specific to a document, not an editor, so we
    // need to update our representation of the cursors when switching between editors for the same document.
    // This will be unnecessary once #4889 is fixed.
    curHandler.syncCursors();
    await curHandler.updateView({ drawSelection: false, revealRange: false });
  }

  previousActiveEditorId = activeEditorId;

  if (curHandler.vimState.focusChanged) {
    curHandler.vimState.focusChanged = false;

    if (previousActiveEditorId) {
      const prevHandler = ModeHandlerMap.get(previousActiveEditorId);
      prevHandler!.vimState.focusChanged = true;
    }
  }

  return curHandler;
}

/**
 * Loads and validates the user's configuration
 */
async function loadConfiguration() {
  const validatorResults = await configuration.load();

  Logger.configChanged();

  const logger = Logger.get('Configuration');
  logger.debug(`${validatorResults.numErrors} errors found with vim configuration`);

  if (validatorResults.numErrors > 0) {
    for (let validatorResult of validatorResults.get()) {
      switch (validatorResult.level) {
        case 'error':
          logger.error(validatorResult.message);
          break;
        case 'warning':
          logger.warn(validatorResult.message);
          break;
      }
    }
  }
}

/**
 * The extension's entry point
 */
export async function activate(
  context: vscode.ExtensionContext,
  handleLocalDiskChangeEvent: boolean = true
) {
  // before we do anything else, we need to load the configuration
  await loadConfiguration();

  const logger = Logger.get('Extension Startup');
  logger.debug('Start');

  extensionContext = context;
  extensionContext.subscriptions.push(StatusBar);

  // Load state
  Register.loadFromDisk(extensionContext);
  await Promise.all([commandLine.load(extensionContext), globalState.load(extensionContext)]);

  if (vscode.window.activeTextEditor) {
    const filepathComponents = vscode.window.activeTextEditor.document.fileName.split(/\\|\//);
    Register.putByKey(filepathComponents[filepathComponents.length - 1], '%', undefined, true);
  }

  // workspace events
  registerEventListener(
    context,
    vscode.workspace.onDidChangeConfiguration,
    async () => {
      await loadConfiguration();
    },
    false
  );

  registerEventListener(context, vscode.workspace.onDidChangeTextDocument, async (event) => {
    const textWasDeleted = (changeEvent: vscode.TextDocumentChangeEvent) =>
      changeEvent.contentChanges.length === 1 &&
      changeEvent.contentChanges[0].text === '' &&
      changeEvent.contentChanges[0].range.start.line !==
        changeEvent.contentChanges[0].range.end.line;

    const textWasAdded = (changeEvent: vscode.TextDocumentChangeEvent) =>
      changeEvent.contentChanges.length === 1 &&
      (changeEvent.contentChanges[0].text === '\n' ||
        changeEvent.contentChanges[0].text === '\r\n') &&
      changeEvent.contentChanges[0].range.start.line ===
        changeEvent.contentChanges[0].range.end.line;

    if (textWasDeleted(event)) {
      globalState.jumpTracker.handleTextDeleted(event.document, event.contentChanges[0].range);
    } else if (textWasAdded(event)) {
      globalState.jumpTracker.handleTextAdded(
        event.document,
        event.contentChanges[0].range,
        event.contentChanges[0].text
      );
    }

    // Change from VSCode editor should set document.isDirty to true but they initially don't!
    // There is a timing issue in VSCode codebase between when the isDirty flag is set and
    // when registered callbacks are fired. https://github.com/Microsoft/vscode/issues/11339
    const contentChangeHandler = (modeHandler: ModeHandler) => {
      if (modeHandler.vimState.currentMode === Mode.Insert) {
        if (modeHandler.vimState.historyTracker.currentContentChanges === undefined) {
          modeHandler.vimState.historyTracker.currentContentChanges = [];
        }

        modeHandler.vimState.historyTracker.currentContentChanges = modeHandler.vimState.historyTracker.currentContentChanges.concat(
          event.contentChanges
        );
      }
    };

    if (Globals.isTesting && Globals.mockModeHandler) {
      contentChangeHandler(Globals.mockModeHandler);
    } else {
      ModeHandlerMap.getAll()
        .filter((modeHandler) => modeHandler.vimState.identity.fileName === event.document.fileName)
        .forEach((modeHandler) => {
          contentChangeHandler(modeHandler);
        });
    }

    if (handleLocalDiskChangeEvent) {
      setTimeout(() => {
        if (!event.document.isDirty && !event.document.isUntitled && event.contentChanges.length) {
          handleContentChangedFromDisk(event.document);
        }
      }, 0);
    }
  });

  registerEventListener(
    context,
    vscode.workspace.onDidCloseTextDocument,
    async (closedDocument) => {
      const documents = vscode.workspace.textDocuments;

      // Delete modehandler once all tabs of this document have been closed
      for (let editorIdentity of ModeHandlerMap.getKeys()) {
        const modeHandler = ModeHandlerMap.get(editorIdentity);

        let shouldDelete = false;
        if (modeHandler == null || modeHandler.vimState.editor === undefined) {
          shouldDelete = true;
        } else {
          const document = modeHandler.vimState.document;
          if (!documents.includes(document)) {
            shouldDelete = true;
            if (closedDocument === document) {
              lastClosedModeHandler = modeHandler;
            }
          }
        }

        if (shouldDelete) {
          ModeHandlerMap.delete(editorIdentity);
        }
      }
    },
    false
  );

  registerEventListener(context, vscode.workspace.onDidSaveTextDocument, async (document) => {
    if (
      configuration.vimrc.enable &&
      path.relative(document.fileName, configuration.vimrc.path) === ''
    ) {
      await configuration.load();
      vscode.window.showInformationMessage('Sourced new .vimrc');
    }
  });

  // window events
  registerEventListener(
    context,
    vscode.window.onDidChangeActiveTextEditor,
    async () => {
      const mhPrevious: ModeHandler | undefined = previousActiveEditorId
        ? ModeHandlerMap.get(previousActiveEditorId)
        : undefined;
      // Track the closed editor so we can use it the next time an open event occurs.
      // When vscode changes away from a temporary file, onDidChangeActiveTextEditor first twice.
      // First it fires when leaving the closed editor. Then onDidCloseTextDocument first, and we delete
      // the old ModeHandler. Then a new editor opens.
      //
      // This also applies to files that are merely closed, which allows you to jump back to that file similarly
      // once a new file is opened.
      lastClosedModeHandler = mhPrevious || lastClosedModeHandler;

      if (vscode.window.activeTextEditor === undefined) {
        Register.putByKey('', '%', undefined, true);
        return;
      }

      const filepathComponents = vscode.window.activeTextEditor.document.fileName.split(/\\|\//);
      Register.putByKey(filepathComponents[filepathComponents.length - 1], '%', undefined, true);

      taskQueue.enqueueTask(async () => {
        const mh = await getAndUpdateModeHandler(true);
        if (mh) {
          globalState.jumpTracker.handleFileJump(
            lastClosedModeHandler ? Jump.fromStateNow(lastClosedModeHandler.vimState) : null,
            Jump.fromStateNow(mh.vimState)
          );
        }
      });
    },
    true,
    true
  );

  registerEventListener(
    context,
    vscode.window.onDidChangeTextEditorSelection,
    async (e: vscode.TextEditorSelectionChangeEvent) => {
      if (
        vscode.window.activeTextEditor === undefined ||
        e.textEditor.document !== vscode.window.activeTextEditor.document
      ) {
        // We don't care if user selection changed in a paneled window (e.g debug console/terminal)
        return;
      }

      const mh = await getAndUpdateModeHandler();
      if (mh === undefined) {
        // We don't care if there is no active editor
        return;
      }

      if (e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) {
        const selectionsHash = e.selections.reduce(
          (hash, s) =>
            hash +
            `[${s.anchor.line}, ${s.anchor.character}; ${s.active.line}, ${s.active.character}]`,
          ''
        );
        const idx = mh.vimState.selectionsChanged.ourSelections.indexOf(selectionsHash);
        if (idx > -1) {
          mh.vimState.selectionsChanged.ourSelections.splice(idx, 1);
          logger.debug(
            `Selections: Ignoring selection: ${selectionsHash}, Count left: ${mh.vimState.selectionsChanged.ourSelections.length}`
          );
          return;
        } else if (mh.vimState.selectionsChanged.ignoreIntermediateSelections) {
          logger.debug(`Selections: ignoring intermediate selection change: ${selectionsHash}`);
          return;
        } else if (mh.vimState.selectionsChanged.ourSelections.length > 0) {
          // Some intermediate selection must have slipped in after setting the
          // 'ignoreIntermediateSelections' to false. Which means we didn't count
          // for it yet, but since we have selections to be ignored then we probably
          // wanted this one to be ignored as well.
          logger.debug(`Selections: Ignoring slipped selection: ${selectionsHash}`);
          return;
        }
      }

      // We may receive changes from other panels when, having selections in them containing the same file
      // and changing text before the selection in current panel.
      if (e.textEditor !== mh.vimState.editor) {
        return;
      }

      if (mh.vimState.focusChanged) {
        mh.vimState.focusChanged = false;
        return;
      }

      if (mh.currentMode === Mode.EasyMotionMode) {
        return;
      }

      taskQueue.enqueueTask(
        () => mh.handleSelectionChange(e),
        undefined,
        /**
         * We don't want these to become backlogged! If they do, we'll update
         * the selection to an incorrect value and see a jittering cursor.
         */
        true
      );
    },
    true,
    false
  );

  const compositionState = new CompositionState();

  // Override VSCode commands
  overrideCommand(context, 'type', async (args) => {
    taskQueue.enqueueTask(async () => {
      const mh = await getAndUpdateModeHandler();
      if (mh) {
        if (compositionState.isInComposition) {
          compositionState.composingText += args.text;
        } else {
          await mh.handleKeyEvent(args.text);
        }
      }
    });
  });

  overrideCommand(context, 'replacePreviousChar', async (args) => {
    taskQueue.enqueueTask(async () => {
      const mh = await getAndUpdateModeHandler();
      if (mh) {
        if (compositionState.isInComposition) {
          compositionState.composingText =
            compositionState.composingText.substr(
              0,
              compositionState.composingText.length - args.replaceCharCnt
            ) + args.text;
        } else {
          await vscode.commands.executeCommand('default:replacePreviousChar', {
            text: args.text,
            replaceCharCnt: args.replaceCharCnt,
          });
          mh.vimState.cursorStopPosition = mh.vimState.editor.selection.start;
          mh.vimState.cursorStartPosition = mh.vimState.editor.selection.start;
        }
      }
    });
  });

  overrideCommand(context, 'compositionStart', async () => {
    taskQueue.enqueueTask(async () => {
      compositionState.isInComposition = true;
    });
  });

  overrideCommand(context, 'compositionEnd', async () => {
    taskQueue.enqueueTask(async () => {
      const mh = await getAndUpdateModeHandler();
      if (mh) {
        const text = compositionState.composingText;
        compositionState.reset();
        mh.handleMultipleKeyEvents(text.split(''));
      }
    });
  });

  // Register extension commands
  registerCommand(context, 'vim.showQuickpickCmdLine', async () => {
    const mh = await getAndUpdateModeHandler();
    if (mh) {
      await commandLine.PromptAndRun('', mh.vimState);
      mh.updateView();
    }
  });

  registerCommand(context, 'vim.remap', async (args: ICodeKeybinding) => {
    taskQueue.enqueueTask(async () => {
      const mh = await getAndUpdateModeHandler();
      if (mh === undefined) {
        return;
      }

      if (args.after) {
        for (const key of args.after) {
          await mh.handleKeyEvent(Notation.NormalizeKey(key, configuration.leader));
        }
        return;
      }

      if (args.commands) {
        for (const command of args.commands) {
          // Check if this is a vim command by looking for :
          if (command.command.startsWith(':')) {
            await commandLine.Run(command.command.slice(1, command.command.length), mh.vimState);
            mh.updateView();
          } else {
            vscode.commands.executeCommand(command.command, command.args);
          }
        }
      }
    });
  });

  registerCommand(context, 'toggleVim', async () => {
    configuration.disableExtension = !configuration.disableExtension;
    toggleExtension(configuration.disableExtension, compositionState);
  });

  registerCommand(
    context,
    'vim.editVimrc',
    async () => {
      const document = await vscode.workspace.openTextDocument(configuration.vimrc.path);
      await vscode.window.showTextDocument(document);
    },
    false
  );

  for (const boundKey of configuration.boundKeyCombinations) {
    const command = ['<Esc>', '<C-c>'].includes(boundKey.key)
      ? async () => {
          const didStopRemap = await forceStopRecursiveRemap();
          if (!didStopRemap) {
            handleKeyEvent(`${boundKey.key}`);
          }
        }
      : () => {
          handleKeyEvent(`${boundKey.key}`);
        };
    registerCommand(context, boundKey.command, command);
  }

  {
    // Initialize mode handler for current active Text Editor at startup.
    const modeHandler = await getAndUpdateModeHandler();
    if (modeHandler) {
      // This is called last because getAndUpdateModeHandler() will change cursor
      modeHandler.updateView({ drawSelection: false, revealRange: false });
    }
  }

  // Disable automatic keyboard navigation in lists, so it doesn't interfere
  // with our list navigation keybindings
  await VSCodeContext.set('listAutomaticKeyboardNavigation', false);

  await toggleExtension(configuration.disableExtension, compositionState);

  logger.debug('Finish.');
}

/**
 * Toggles the VSCodeVim extension between Enabled mode and Disabled mode. This
 * function is activated by calling the 'toggleVim' command from the Command Palette.
 *
 * @param isDisabled if true, sets VSCodeVim to Disabled mode; else sets to enabled mode
 */
async function toggleExtension(isDisabled: boolean, compositionState: CompositionState) {
  await VSCodeContext.set('vim.active', !isDisabled);
  const mh = await getAndUpdateModeHandler();
  if (mh) {
    if (isDisabled) {
      await mh.handleKeyEvent(SpecialKeys.ExtensionDisable);
      compositionState.reset();
      ModeHandlerMap.clear();
    } else {
      await mh.handleKeyEvent(SpecialKeys.ExtensionEnable);
    }
  }
}

function overrideCommand(
  context: vscode.ExtensionContext,
  command: string,
  callback: (...args: any[]) => any
) {
  const disposable = vscode.commands.registerCommand(command, async (args) => {
    if (configuration.disableExtension) {
      return vscode.commands.executeCommand('default:' + command, args);
    }

    if (!vscode.window.activeTextEditor) {
      return;
    }

    if (
      vscode.window.activeTextEditor.document &&
      vscode.window.activeTextEditor.document.uri.toString() === 'debug:input'
    ) {
      return vscode.commands.executeCommand('default:' + command, args);
    }

    return callback(args);
  });
  context.subscriptions.push(disposable);
}

function registerCommand(
  context: vscode.ExtensionContext,
  command: string,
  callback: (...args: any[]) => any,
  requiresActiveEditor: boolean = true
) {
  const disposable = vscode.commands.registerCommand(command, async (args) => {
    if (requiresActiveEditor && !vscode.window.activeTextEditor) {
      return;
    }

    callback(args);
  });
  context.subscriptions.push(disposable);
}

function registerEventListener<T>(
  context: vscode.ExtensionContext,
  event: vscode.Event<T>,
  listener: (e: T) => void,
  exitOnExtensionDisable = true,
  exitOnTests = false
) {
  const disposable = event(async (e) => {
    if (exitOnExtensionDisable && configuration.disableExtension) {
      return;
    }

    if (exitOnTests && Globals.isTesting) {
      return;
    }

    listener(e);
  });
  context.subscriptions.push(disposable);
}

async function handleKeyEvent(key: string): Promise<void> {
  const mh = await getAndUpdateModeHandler();
  if (mh) {
    taskQueue.enqueueTask(async () => {
      await mh.handleKeyEvent(key);
    });
  }
}

/**
 * @returns true if there was a remap being executed to stop
 */
async function forceStopRecursiveRemap(): Promise<boolean> {
  const mh = await getAndUpdateModeHandler();
  if (mh?.vimState.isCurrentlyPerformingRecursiveRemapping) {
    mh.vimState.forceStopRecursiveRemapping = true;
    return true;
  }

  return false;
}

function handleContentChangedFromDisk(document: vscode.TextDocument): void {
  ModeHandlerMap.getAll()
    .filter((modeHandler) => modeHandler.vimState.identity.fileName === document.fileName)
    .forEach((modeHandler) => {
      modeHandler.vimState.historyTracker.clear();
    });
}
