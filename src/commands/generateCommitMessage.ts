import type { TextEditor, Uri } from 'vscode';
import { ProgressLocation, window } from 'vscode';
import { fetch } from '@env/fetch';
import { Commands, CoreCommands } from '../constants';
import type { Container } from '../container';
import { GitUri } from '../git/gitUri';
import { GitRevision } from '../git/models/reference';
import { Logger } from '../logger';
import { showGenericErrorMessage } from '../messages';
import { RepositoryPicker } from '../quickpicks/repositoryPicker';
import { command, executeCoreCommand } from '../system/command';
import { ActiveEditorCommand, Command, getCommandUri } from './base';

export interface GenerateCommitMessageCommandArgs {
	repoPath?: string;
}

@command()
export class GenerateCommitMessageCommand extends ActiveEditorCommand {
	constructor(private readonly container: Container) {
		super(Commands.GenerateCommitMessage);
	}

	async execute(editor?: TextEditor, uri?: Uri, args?: GenerateCommitMessageCommandArgs) {
		args = { ...args };

		let openaiApiKey = await this.container.storage.getSecret('gitlens.openai.key');
		if (!openaiApiKey) {
			const result = await window.showInputBox({
				placeHolder: 'Please enter your OpenAI API key to use this feature',
				prompt: 'Enter your OpenAI API key',
				validateInput: function (value: string) {
					if (!value || !/sk-[a-zA-Z0-9]{32}/.test(value)) return 'Please enter a valid OpenAI API key';
					return undefined;
				},
			});

			if (!result) return;

			openaiApiKey = result;
			void this.container.storage.storeSecret('gitlens.openai.key', openaiApiKey);
		}

		let repository;
		if (args.repoPath != null) {
			repository = this.container.git.getRepository(args.repoPath);
		} else {
			uri = getCommandUri(uri, editor);

			const gitUri = uri != null ? await GitUri.fromUri(uri) : undefined;

			repository = await RepositoryPicker.getBestRepositoryOrShow(gitUri, editor, 'Generate Commit Message');
		}
		if (repository == null) return;

		const scmRepo = await this.container.git.getScmRepository(repository.path);
		if (scmRepo == null) return;

		try {
			const diff = await this.container.git.getDiff(repository.uri, GitRevision.uncommittedStaged);
			if (diff?.diff == null) {
				void window.showInformationMessage('No staged changes to generate a commit message from.');

				return;
			}

			const code = diff.diff.substring(0, 8000);

			const prompt = `Commit messages have a less than 50 character short description followed by a new line and then a longer more detailed description. Using an informal tone, write a very concise but meaningful commit message by summarizing the changes in code diff between ---. Don't repeat yourself and avoid punctuation, filler words, filenames, names from the code, and phrases like "this commit", "this diff", "this change", "these changes".\n\n---\n${code}\n---`;
			const data: OpenAICompletionRequest = {
				model: 'text-davinci-003', // code-davinci-002
				prompt: prompt,
				max_tokens: 500,
				temperature: 0.5,
				top_p: 1.0,
				stream: false,
			};

			await window.withProgress(
				{ location: ProgressLocation.Notification, title: 'Generating commit message...' },
				async () => {
					const rsp = await fetch('https://api.openai.com/v1/completions', {
						headers: {
							Authorization: `Bearer ${openaiApiKey}`,
							'Content-Type': 'application/json',
						},
						method: 'POST',
						body: JSON.stringify(data),
					});

					if (!rsp.ok) {
						void showGenericErrorMessage(
							`Unable to generate commit message: ${rsp.status}: ${rsp.statusText}`,
						);

						return;
					}

					const completion: OpenAICompletionResponse = await rsp.json();

					void executeCoreCommand(CoreCommands.ShowSCM);

					const message = completion.choices[0].text.trim();
					scmRepo.inputBox.value = `${
						scmRepo.inputBox.value ? `${scmRepo.inputBox.value}\n\n` : ''
					}${message}`;
				},
			);
			if (diff.diff.length > 8000) {
				void window.showWarningMessage(
					"The diff of the staged changes had to be truncated to 8000 characters to fit within the OpenAI's limits.",
				);
			}
		} catch (ex) {
			Logger.error(ex, 'GenerateCommitMessageCommand');
			void showGenericErrorMessage('Unable to generate commit message');
		}
	}
}

interface OpenAICompletionRequest {
	model: string;
	prompt?: string | string[];
	suffix?: string;
	max_tokens?: number;
	temperature?: number;
	top_p?: number;
	n?: number;
	stream?: boolean;
	logprobs?: number;
	echo?: boolean;
	stop?: string | string[];
	presence_penalty?: number;
	frequency_penalty?: number;
	best_of?: number;
	logit_bias?: { [token: string]: number };
	user?: string;
}

interface OpenAICompletionResponse {
	id: string;
	object: 'text_completion' | string;
	created: number;
	model: string;
	choices: {
		text: string;
		index: number;
		logprobs?: number | null;
		finish_reason: string;
	}[];
	usage: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

@command()
export class ResetOpenAIKeyCommand extends Command {
	constructor(private readonly container: Container) {
		super(Commands.ResetOpenAIKey);
	}

	execute() {
		void this.container.storage.deleteSecret('gitlens.openai.key');
	}
}
