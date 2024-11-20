import {
	Plugin,
	PluginSettingTab,
	App,
	Setting,
	Notice,
	normalizePath,
	request,
} from "obsidian";

class PluginInfo {
	constructor(
		public name: string,
		public path: string,
		public id: string,
		public version: string,
		public author: string,
		public description: string
	) { }
}

interface PluginManagerSettings {
	plugins: PluginConfig[];
}

interface PluginConfig {
	id: string;
	repo: string; // GitHub Repo (e.g., "owner/repository")
	releaseTag: string | undefined; // Release tag (e.g., "latest" or "2.2.1")
}

const DEFAULT_SETTINGS: PluginManagerSettings = {
	plugins: [],
};

export default class PluginManager extends Plugin {
	settings: PluginManagerSettings;

	async getPluginsFolderPath(): Promise<string> {
		return normalizePath(".obsidian/plugins");
	}

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new PluginManagerSettingTab(this.app, this));
	}

	// 설치된 플러그인 목록 확인
	async listInstalledPlugins(): Promise<PluginInfo[]> {
		try {
			const pluginsFolder = await this.getPluginsFolderPath();
			const files = await this.app.vault.adapter.list(pluginsFolder);
			const plugins = files.folders || [];

			return await Promise.all(
				plugins.map(async (pluginPath) => {
					const manifestPath = `${pluginPath}/manifest.json`;
					let name = "Unknown";
					let id = "Unknown";
					let version = "Unknown";
					let author = "Unknown";
					let description = "No description available";

					try {
						const manifestContent = await this.app.vault.adapter.read(manifestPath);
						const manifest = JSON.parse(manifestContent);
						name = manifest.name;
						id = manifest.id;
						version = manifest.version;
						author = manifest.author;
						description = manifest.description;
					} catch {
						// 무시하고 기본값 유지
					}

					return new PluginInfo(name, pluginPath, id, version, author, description);
				})
			);
		} catch (error) {
			console.error("Failed to list installed plugins:", error);
			return [];
		}
	}

	// 플러그인 다운로드 및 설치
	async downloadAndInstallPlugin(pluginConfig: PluginConfig, pluginInfo: PluginInfo | undefined) {
		const baseUrl = `https://github.com/${pluginConfig.repo}/releases/download/${pluginConfig.releaseTag || pluginInfo?.version}`;
		const loadingNotice = new Notice(`Installing ${pluginConfig.id}...`, 0);

		try {
			// 필요한 파일 다운로드
			await this.downloadAndSaveFile(`${baseUrl}/main.js`, pluginConfig.id, "main.js");
			await this.downloadAndSaveFile(`${baseUrl}/manifest.json`, pluginConfig.id, "manifest.json", true);
			await this.downloadAndSaveFile(`${baseUrl}/styles.css`, pluginConfig.id, "styles.css", true);

			new Notice(`${pluginConfig.id} installed successfully!`);
		} catch (error) {
			new Notice(`Failed to install ${pluginConfig.id}. Check the console for details.`);
			console.error(error);
		} finally {
			loadingNotice.hide();
		}
	}

	// 파일 다운로드 및 저장
	async downloadAndSaveFile(fileUrl: string, pluginId: string, fileName: string, optional = false) {
		try {
			const fileContent = await request({ url: fileUrl });
			if (fileContent === "Not Found" || fileContent === `{"error":"Not Found"}`) {
				if (optional) return; // 선택적 파일은 다운로드 실패 시 무시
				throw new Error(`Failed to download ${fileName}: ${fileContent}`);
			}

			const pluginsFolder = await this.getPluginsFolderPath();
			const pluginFolderPath = `${pluginsFolder}/${pluginId}`;

			await this.app.vault.adapter.mkdir(pluginFolderPath);
			await this.app.vault.adapter.write(`${pluginFolderPath}/${fileName}`, fileContent);
		} catch (error) {
			if (!optional) throw error;
			console.warn(`Optional file ${fileName} not found at ${fileUrl}.`);
		}
	}

	// 모든 플러그인 다운로드
	async downloadAllPlugins() {
		const plugins = this.settings.plugins;
		if (plugins.length === 0) {
			new Notice("No plugins configured to download.");
			return;
		}
		const installedPlugins = await this.listInstalledPlugins();

		const startNotice = new Notice("Starting download for all plugins...", 0);
		const results = await Promise.all(
			plugins.map((pluginConfig) => {
				const pluginInfo = installedPlugins.find((p) => p.id === pluginConfig.id);
				return this.downloadAndInstallPlugin(pluginConfig, pluginInfo)
					.then(() => true)
					.catch((err) => {
						console.error(`Failed to download plugin: ${pluginConfig.id}`, err);
						return false;
					});
			}
			)
		);

		const successCount = results.filter((success) => success).length;
		new Notice(`Downloaded ${successCount} out of ${plugins.length} plugins successfully.`);
		startNotice.hide();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class PluginManagerSettingTab extends PluginSettingTab {
	plugin: PluginManager;
	communityPluginsPromise: Promise<{ id: string; repo: string }[]>;

	constructor(app: App, plugin: PluginManager) {
		super(app, plugin);
		this.plugin = plugin;
		this.communityPluginsPromise = this.getCommunityPlugins();
	}

	async getCommunityPlugins(): Promise<{ id: string; repo: string }[]> {
		try {
			const response = await fetch(
				"https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json"
			);
			if (!response.ok) throw new Error("Failed to fetch community plugins");
			return await response.json();
		} catch (error) {
			console.error("Failed to fetch community plugins list:", error);
			return [];
		}
	}

	async display(): Promise<void> {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Plugin Manager Settings" });

		// 모든 플러그인 다운로드 버튼
		const downloadAllButton = containerEl.createEl("button", { text: "Download All Plugins" });
		downloadAllButton.addEventListener("click", async () => {
			await this.plugin.downloadAllPlugins();
		});

		// 플러그인 설정 정렬
		this.plugin.settings.plugins.sort((a, b) => a.id.localeCompare(b.id));

		// 설치된 플러그인 목록 출력
		const installedPlugins = await this.plugin.listInstalledPlugins();
		if (installedPlugins.length === 0) {
			containerEl.createEl("p", { text: "No plugins found." });
		}

		const communityPlugins = await this.communityPluginsPromise;
		installedPlugins.forEach((pluginInfo) => {
			const communityPlugin = communityPlugins.find((p) => p.id === pluginInfo.id);
			const pluginConfig =
				this.plugin.settings.plugins.find((p) => p.id === pluginInfo.id) ||
				this.addPluginConfig(pluginInfo.id, communityPlugin?.repo || "");

			const setting = new Setting(containerEl)
				.setName(pluginInfo.name)
				.setDesc(pluginInfo.description);

			// GitHub Repo 입력
			setting.addText((text) =>
				text
					.setPlaceholder(communityPlugin?.repo || "Enter GitHub repo (e.g., owner/repository)")
					.setValue(pluginConfig.repo || "")
					.onChange(async (value) => {
						pluginConfig.repo = value || communityPlugin?.repo || "";
						await this.plugin.saveSettings();
					})
			);

			// 릴리스 태그 입력
			setting.addText((text) =>
				text
					.setPlaceholder(pluginInfo.version)
					.setValue(pluginConfig.releaseTag || "")
					.onChange(async (value) => {
						pluginConfig.releaseTag = value || pluginInfo.version;
						await this.plugin.saveSettings();
					})
			);

			// 설치 버튼
			setting.addButton((button) =>
				button
					.setButtonText("Install")
					.setCta()
					.onClick(async () => {
						if (!pluginConfig.repo) {
							new Notice("GitHub repo is required to install this plugin.");
							return;
						}
						await this.plugin.downloadAndInstallPlugin(pluginConfig, pluginInfo);
					})
			);
		});

		this.plugin.saveSettings();
	}

	private addPluginConfig(pluginId: string, pluginRepo: string): PluginConfig {
		const newConfig: PluginConfig = {
			id: pluginId,
			repo: pluginRepo,
			releaseTag: undefined,
		};
		this.plugin.settings.plugins.push(newConfig);
		this.plugin.settings.plugins.sort((a, b) => a.id.localeCompare(b.id));
		return newConfig;
	}
}
