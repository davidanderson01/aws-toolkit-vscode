/*!
 * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { getTabSizeSetting } from '../../shared/utilities/editorUtilities'
import * as KeyStrokeHandler from './service/keyStrokeHandler'
import * as EditorContext from './util/editorContext'
import { ConsolasConstants } from './models/constants'
import { getCompletionItems } from './service/completionProvider'
import { invokeConsolas } from './commands/invokeConsolas'
import { onAcceptance } from './commands/onAcceptance'
import { TelemetryHelper } from './util/telemetryHelper'
import { onRejection } from './commands/onRejection'
import { DefaultSettingsConfiguration } from './../../shared/settingsConfiguration'
import { activate as activateView } from './vue/backend'
import { ExtContext } from '../../shared/extensions'
import { TextEditorSelectionChangeKind } from 'vscode'
import * as telemetry from '../../shared/telemetry/telemetry'
import { ConsolasTracker } from './tracker/consolasTracker'
import * as consolasClient from './client/consolas'
import { LanguageContext } from './util/runtimeLanguageContext'
import { OpenConsolasSettings } from './commands/openConsolasSettings'
import { getLogger } from '../../shared/logger'

export async function activate(context: ExtContext): Promise<void> {
    /**
     * Enable essential intellisense default settings
     */
    const languageContext = new LanguageContext()
    await languageContext.initLanguageRuntimeContexts()
    await enableDefaultConfig()
    /**
     * Service control
     */
    const mainSettings = new DefaultSettingsConfiguration()
    ConsolasTracker.toolkitSettings = mainSettings
    const isManualTriggerEnabled: boolean = getManualTriggerStatus()
    const isAutomatedTriggerEnabled: boolean =
        context.extensionContext.globalState.get<boolean>(ConsolasConstants.CONSOLAS_AUTO_TRIGGER_ENABLED_KEY) || false

    const client = await new consolasClient.DefaultConsolasClient().createSdkClient()
    context.extensionContext.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async configurationChangeEvent => {
            if (configurationChangeEvent.affectsConfiguration('editor.tabSize')) {
                EditorContext.updateTabSize(getTabSizeSetting())
            }
            if (configurationChangeEvent.affectsConfiguration('aws.experiments')) {
                const consolasPreviewEnabled: boolean =
                    vscode.workspace.getConfiguration('aws.experiments').get(ConsolasConstants.CONSOLAS_PREVIEW) ||
                    false
                if (!consolasPreviewEnabled) {
                    set(ConsolasConstants.CONSOLAS_TERMS_ACCEPTED_KEY, false)
                    set(ConsolasConstants.CONSOLAS_AUTO_TRIGGER_ENABLED_KEY, false)
                }
                vscode.commands.executeCommand('aws.refreshAwsExplorer')
            }
        })
    )
    context.extensionContext.subscriptions.push(
        vscode.commands.registerCommand('aws.consolas.pauseCodeSuggestion', async () => {
            const autoTriggerEnabled: boolean =
                context.extensionContext.globalState.get<boolean>(
                    ConsolasConstants.CONSOLAS_AUTO_TRIGGER_ENABLED_KEY
                ) || false
            set(ConsolasConstants.CONSOLAS_AUTO_TRIGGER_ENABLED_KEY, !autoTriggerEnabled)
            await vscode.commands.executeCommand('aws.refreshAwsExplorer')
        })
    )
    context.extensionContext.subscriptions.push(
        vscode.commands.registerCommand('aws.consolas.resumeCodeSuggestion', async () => {
            const autoTriggerEnabled: boolean =
                context.extensionContext.globalState.get<boolean>(
                    ConsolasConstants.CONSOLAS_AUTO_TRIGGER_ENABLED_KEY
                ) || false
            set(ConsolasConstants.CONSOLAS_AUTO_TRIGGER_ENABLED_KEY, !autoTriggerEnabled)
            await vscode.commands.executeCommand('aws.refreshAwsExplorer')
        })
    )
    context.extensionContext.subscriptions.push(
        vscode.commands.registerCommand('aws.consolas.acceptTermsAndConditions', async () => {
            set(ConsolasConstants.CONSOLAS_AUTO_TRIGGER_ENABLED_KEY, true)
            set(ConsolasConstants.CONSOLAS_TERMS_ACCEPTED_KEY, true)
            await vscode.commands.executeCommand('setContext', ConsolasConstants.CONSOLAS_TERMS_ACCEPTED_KEY, true)
            await vscode.commands.executeCommand('aws.refreshAwsExplorer')
            /**
             *  TODO Beta landing page removes in GA state
             */
            const isShow = get(ConsolasConstants.CONSOLAS_WELCOME_MESSAGE_KEY)
            if (!isShow) {
                showConsolasWelcomeMessage()
                set(ConsolasConstants.CONSOLAS_WELCOME_MESSAGE_KEY, true)
            }
        })
    )
    context.extensionContext.subscriptions.push(
        vscode.commands.registerCommand('aws.consolas.cancelTermsAndConditions', async () => {
            set(ConsolasConstants.CONSOLAS_AUTO_TRIGGER_ENABLED_KEY, false)
            await vscode.commands.executeCommand('aws.refreshAwsExplorer')
        })
    )
    context.extensionContext.subscriptions.push(
        vscode.commands.registerCommand('aws.consolas.configure', async () => {
            await OpenConsolasSettings()
        }),
        vscode.commands.registerCommand('aws.consolas.introduction', async () => {
            vscode.env.openExternal(vscode.Uri.parse(ConsolasConstants.CONSOLAS_LEARN_MORE_URI))
        })
    )

    /**
     * Manual trigger
     */
    context.extensionContext.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(ConsolasConstants.SUPPORTED_LANGUAGES, {
            async provideCompletionItems(
                document: vscode.TextDocument,
                position: vscode.Position,
                token: vscode.CancellationToken,
                context: vscode.CompletionContext
            ) {
                const completionList = new vscode.CompletionList(getCompletionItems(document, position), false)
                return completionList
            },
        })
    )
    context.extensionContext.subscriptions.push(
        vscode.commands.registerCommand('aws.consolas', async () => {
            const isShowMethodsOn: boolean =
                vscode.workspace.getConfiguration('editor').get('suggest.showMethods') || false
            const isAutomatedTriggerOn: boolean =
                context.extensionContext.globalState.get<boolean>(
                    ConsolasConstants.CONSOLAS_AUTO_TRIGGER_ENABLED_KEY
                ) || false
            const isManualTriggerOn: boolean = getManualTriggerStatus()
            invokeConsolas(
                vscode.window.activeTextEditor as vscode.TextEditor,
                client,
                isShowMethodsOn,
                isManualTriggerOn,
                isAutomatedTriggerOn
            )
        })
    )
    /**
     * Automated trigger
     */
    context.extensionContext.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            if (
                e.document === vscode.window.activeTextEditor?.document &&
                languageContext.convertLanguage(e.document.languageId) !== 'plaintext' &&
                e.contentChanges.length != 0
            ) {
                const isAutoTriggerOn: boolean =
                    context.extensionContext.globalState.get<boolean>(
                        ConsolasConstants.CONSOLAS_AUTO_TRIGGER_ENABLED_KEY
                    ) || false
                KeyStrokeHandler.processKeyStroke(
                    e,
                    vscode.window.activeTextEditor,
                    client,
                    isManualTriggerEnabled,
                    isAutoTriggerOn
                )
            }
        })
    )
    context.extensionContext.subscriptions.push(
        vscode.commands.registerCommand('aws.consolas.enabledCodeSuggestions', () => {
            activateView(context)
        })
    )

    /**
     * On recommendation acceptance
     */
    context.extensionContext.subscriptions.push(
        vscode.commands.registerCommand(
            'aws.consolas.accept',
            async (
                line: number,
                acceptIndex: number,
                recommendation: string,
                requestId: string,
                triggerType: telemetry.ConsolasTriggerType,
                completionType: telemetry.ConsolasCompletionType,
                language: telemetry.ConsolasLanguage
            ) => {
                const isAutoClosingBracketsEnabled: boolean =
                    vscode.workspace.getConfiguration('editor').get('autoClosingBrackets') || false
                const editor = vscode.window.activeTextEditor
                onAcceptance(
                    {
                        editor,
                        line,
                        acceptIndex,
                        recommendation,
                        requestId,
                        triggerType,
                        completionType,
                        language,
                    },
                    isAutoClosingBracketsEnabled
                )
            }
        )
    )

    /**
     * On recommendation rejection
     */
    context.extensionContext.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(e => {
            onRejection(isManualTriggerEnabled, isAutomatedTriggerEnabled)
        })
    )
    context.extensionContext.subscriptions.push(
        vscode.window.onDidChangeVisibleTextEditors(e => {
            onRejection(isManualTriggerEnabled, isAutomatedTriggerEnabled)
        })
    )
    context.extensionContext.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(e => {
            onRejection(isManualTriggerEnabled, isAutomatedTriggerEnabled)
        })
    )
    context.extensionContext.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(e => {
            if (e.kind === TextEditorSelectionChangeKind.Mouse) {
                onRejection(isManualTriggerEnabled, isAutomatedTriggerEnabled)
            }
        })
    )

    async function showConsolasWelcomeMessage(): Promise<void> {
        const filePath = context.extensionContext.asAbsolutePath(ConsolasConstants.WELCOME_CONSOLAS_README_FILE_SOURCE)
        const readmeUri = vscode.Uri.file(filePath)
        await vscode.commands.executeCommand('markdown.showPreviewToSide', readmeUri)
    }

    context.extensionContext.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(e => {
            TelemetryHelper.recordUserDecisionTelemetry(-1, vscode.window.activeTextEditor?.document.languageId)
        })
    )

    function get(key: string): string | undefined {
        return context.extensionContext.globalState.get(key)
    }

    function set(key: string, value: any): void {
        context.extensionContext.globalState.update(key, value).then(
            () => {},
            error => {
                getLogger().verbose(`Failed to update global state: ${error}`)
            }
        )
    }

    function getManualTriggerStatus(): boolean {
        const isConsolasPreviewOn: boolean =
            vscode.workspace.getConfiguration('aws.experiments').get(ConsolasConstants.CONSOLAS_PREVIEW) || false
        const acceptedTerms: boolean =
            context.extensionContext.globalState.get<boolean>(ConsolasConstants.CONSOLAS_TERMS_ACCEPTED_KEY) || false
        return acceptedTerms && isConsolasPreviewOn
    }
}

export async function shutdown() {
    TelemetryHelper.recordUserDecisionTelemetry(-1, vscode.window.activeTextEditor?.document.languageId)
    ConsolasTracker.getTracker().shutdown()
}

export async function enableDefaultConfig() {
    const editorSettings = vscode.workspace.getConfiguration('editor')
    await editorSettings.update('suggest.showMethods', true, vscode.ConfigurationTarget.Global)
    await editorSettings.update('suggest.preview', true, vscode.ConfigurationTarget.Global)
    await editorSettings.update('acceptSuggestionOnEnter', 'on', vscode.ConfigurationTarget.Global)
    await editorSettings.update('snippetSuggestions', 'top', vscode.ConfigurationTarget.Global)
}
