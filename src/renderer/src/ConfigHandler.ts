import { DateTime } from "luxon";
import axios, { AxiosResponse } from "axios";
import { ConfigData, MainCallbackType } from "../../shared/types";

export type ConfigHandlerOpenOptions = {
    /** Called when the page is dismissed without the CMS details changing. */
    onClose?: () => void;
};

export class ConfigHandler {
    readonly runApp = (_callbackParams: MainCallbackType): Promise<void> => {
        return Promise.resolve();
    };
    readonly codeChangeInterval = 12.5;

    config: ConfigData;

    $configPanel: HTMLElement | null | undefined;
    $configPanelLoader: HTMLElement | undefined;
    $configPanelCode: HTMLElement | undefined;
    $configPanelManual: HTMLElement | undefined;
    $configPanelError: HTMLElement | undefined;
    $useCodeButton: HTMLButtonElement | undefined;
    $manualConnectButton: HTMLButtonElement | undefined;
    $activePage: HTMLElement | undefined;
    $inactivePage: HTMLElement | undefined;
    $unavailableCode: HTMLElement | undefined;
    codeInterval: NodeJS.Timeout | undefined;
    slideIndex: number;
    timeoutId: NodeJS.Timeout | undefined;
    $closeButton: HTMLButtonElement | null | undefined;
    $topHeaderTitle: HTMLElement | null | undefined;

    /** Guards init() so reopening the page doesn't stack a second set of listeners. */
    private initialised = false;

    /**
     * True when the page was reopened from the on-screen nav bar on a player that is
     * already registered, rather than shown as part of first-boot registration.
     */
    private reopened = false;

    /** Called when a reopened page is dismissed without the CMS details changing. */
    private onClose: (() => void) | undefined;

    /** The first-boot heading, kept so closing a reopened page puts it back. */
    private originalHeaderTitle: string | undefined;

    /** The activation code currently on screen, so the "Hide" toggle can restore it. */
    private activationCode: string | null = null;

    // Claim review — the confirmation step in front of a CMS move.
    $claimReview: HTMLElement | null | undefined;
    $claimReviewTitle: HTMLElement | null | undefined;
    $claimReviewMessage: HTMLElement | null | undefined;
    $claimReviewCurrent: HTMLElement | null | undefined;
    $claimReviewNewRow: HTMLElement | null | undefined;
    $claimReviewNew: HTMLElement | null | undefined;
    $claimReviewAccept: HTMLButtonElement | null | undefined;
    $claimReviewCancel: HTMLButtonElement | null | undefined;

    /** CMS details from a claim that is waiting on the user to accept it. */
    private pendingClaim: { cmsUrl: string; cmsKey: string } | null = null;

    constructor(config: ConfigData, runApp: ({ context }: MainCallbackType) => Promise<void>) {
        this.config = config;
        this.slideIndex = 0;
        this.runApp = runApp;

        console.debug('ConfigHandler initialized', {
            config: this.config,
        });
    }

    init() {
        // Reopening the page from the nav bar calls this again on the same instance.
        // Most listeners below are added with a fresh closure, so removeEventListener
        // cannot match them and a second pass would double up handlers and start a
        // second slideshow chain.
        if (this.initialised) {
            return;
        }
        this.initialised = true;

        // Elements involved in the config panel.
        this.$configPanel = document.getElementById('config');
        this.$closeButton = document.getElementById('config-close') as HTMLButtonElement | null;
        this.$topHeaderTitle = this.$configPanel!.querySelector<HTMLElement>('.top-header h3');
        this.$configPanelLoader = (<HTMLElement>this.$configPanel!.querySelector('#config-loader'));
        this.$configPanelCode = (<HTMLElement>this.$configPanel!.getElementsByClassName('activation-container')[0]);
        this.$configPanelManual = (<HTMLElement>this.$configPanel!.getElementsByClassName('config-container')[0]);
        this.$configPanelError = (<HTMLElement>this.$configPanel!.getElementsByClassName('error')[0]);
        this.$activePage = (<HTMLElement>this.$configPanel!.getElementsByClassName('active-page')[0]);
        this.$inactivePage = (<HTMLElement>this.$configPanel!.getElementsByClassName('inactive-page')[0]);
        this.$unavailableCode = (<HTMLElement>this.$configPanel!.getElementsByClassName('unavailable-code')[0]);

        this.$configPanel!.style.display = 'flex';
        this.$inactivePage?.style.setProperty('display', 'none');
        this.$unavailableCode?.style.setProperty('display', 'none');

        this.$useCodeButton = document.querySelector('button[data-target="activation-code"]') as HTMLButtonElement;
        const handleUseCodeButton = async (evt: Event) => {
            evt.preventDefault();
            const target = evt.target as HTMLButtonElement;

            (target) && target?.classList.add('active');
            (this.$manualConnectButton) && this.$manualConnectButton.classList.remove('active');

            this.$configPanelManual!.style.display = 'none';
            this.$configPanelCode!.style.display = 'grid';
            this.$configPanelError!.textContent = '';
            // this.$configPanelError!.style.display = 'none';

            await this.run();
        };
        this.$manualConnectButton = document.querySelector('button[data-target="configure-manually"]') as HTMLButtonElement;
        const handleManualConnectButton = (evt: Event) => {
            evt.preventDefault();
            const target = evt.target as HTMLButtonElement;

            (target) && target?.classList.add('active');
            (this.$useCodeButton) && this.$useCodeButton.classList.remove('active');

            this.handleManualConnect();

            if (this.codeInterval) clearInterval(this.codeInterval);
        }

        this.$useCodeButton!.removeEventListener('click', handleUseCodeButton);
        this.$useCodeButton!.addEventListener('click', handleUseCodeButton);

        this.$manualConnectButton!.removeEventListener('click', handleManualConnectButton);
        this.$manualConnectButton!.addEventListener('click', handleManualConnectButton);

        const $retryUseCodeBtn = document.getElementById('retry-use-code');
        const handleRetryUseCode = async (evt: Event) => {
            evt.preventDefault();

            this.$configPanelCode!.style.display = 'grid';
            this.$configPanelError!.textContent = '';

            await this.run();
        };

        $retryUseCodeBtn?.removeEventListener('click', handleRetryUseCode);
        $retryUseCodeBtn?.addEventListener('click', handleRetryUseCode);


        const manualSubmitButton = document.getElementById('manualSubmitButton');

        // Listen to the submit button being pressed. The handler is an instance-bound
        // arrow property so removeEventListener can actually match it.
        manualSubmitButton!.removeEventListener('click', this.handleManualSubmitButton);
        manualSubmitButton!.addEventListener('click', this.handleManualSubmitButton);

        for (const field of ConfigHandler.manualFields) {
            ConfigHandler.manualInput(field.name)?.addEventListener('input', this.onManualFieldInput);
        }

        this.$claimReview = document.getElementById('claim-review');
        this.$claimReviewTitle = document.getElementById('claim-review-title');
        this.$claimReviewMessage = document.getElementById('claim-review-message');
        this.$claimReviewCurrent = document.getElementById('claim-review-current');
        this.$claimReviewNewRow = document.getElementById('claim-review-new-row');
        this.$claimReviewNew = document.getElementById('claim-review-new');
        this.$claimReviewAccept = document.getElementById('claim-review-accept') as HTMLButtonElement | null;
        this.$claimReviewCancel = document.getElementById('claim-review-cancel') as HTMLButtonElement | null;

        this.$claimReviewAccept?.addEventListener('click', this.onClaimAccept);
        this.$claimReviewCancel?.addEventListener('click', this.onClaimCancel);

        // Init slides
        this.initSlideDots();
        this.showSlides();

        // Populate config page details section
        this.setConfigDetails();
    }

    /**
     * The manual tab's fields, in validation order. Only the first problem is shown, so
     * this is what decides which one.
     */
    private static readonly manualFields = [
        { name: 'display-name', label: 'Display Name' },
        { name: 'cms-address', label: 'CMS Address' },
        { name: 'cms-key', label: 'CMS Key' },
    ] as const;

    private static manualInput(name: string) {
        return <HTMLInputElement>document.getElementsByName(name)[0];
    }

    readonly handleManualSubmitButton = (evt: Event) => {
        evt.preventDefault();
        const $submitBtn = evt.target as HTMLInputElement;

        const cmsKey = ConfigHandler.manualInput('cms-key').value.trim();
        const displayName = ConfigHandler.manualInput('display-name').value.trim();
        const cmsUrl = ConfigHandler.manualInput('cms-address').value.trim();

        // Nothing was edited, so there is nothing to register. Skip the round trip and
        // the reload it would trigger, and just go back to playback.
        if (this.reopened && this.isSameCms(cmsUrl, cmsKey) && displayName === (this.config.displayName ?? '').trim()) {
            console.debug('[ConfigHandler] Submitted with no changes, closing without re-registering');
            this.close();
            return;
        }

        if (!this.validateManualForm()) {
            return;
        }

        $submitBtn.disabled = true;
        this.$configPanelLoader?.style.setProperty('display', 'block');
        // this.$configPanelManual!.style.display = 'none';

        // Check connection.
        this.config.cmsKey = cmsKey;
        this.config.displayName = displayName;
        this.config.cmsUrl = cmsUrl;

        this.handleRegisterDisplayCallback()
            .finally(() => {
                $submitBtn.disabled = false;
                this.$configPanelLoader?.style.setProperty('display', 'none');
                this.$configPanelManual?.style.setProperty('display', 'grid');
            });
    };

    /**
     * Reports the first problem with the manual tab, marking the field that caused it.
     *
     * @returns true when the form is safe to submit.
     */
    private validateManualForm() {
        this.clearManualErrors();

        for (const field of ConfigHandler.manualFields) {
            const $input = ConfigHandler.manualInput(field.name);

            if ($input.value.trim() === '') {
                this.failManualField($input, `${field.label} is required.`);
                return false;
            }
        }

        const $cmsAddress = ConfigHandler.manualInput('cms-address');

        if (!ConfigHandler.isValidCmsUrl($cmsAddress.value.trim())) {
            this.failManualField($cmsAddress, 'CMS Address must include http:// or https://');
            return false;
        }

        return true;
    }

    // True for an absolute address with an http or https scheme.
    private static isValidCmsUrl(value: string) {
        try {
            const { protocol } = new URL(value);

            return protocol === 'http:' || protocol === 'https:';
        } catch {
            return false;
        }
    }

    private failManualField($input: HTMLInputElement, message: string) {
        this.$configPanelError!.textContent = message;
        $input.classList.add('input--invalid');
        $input.focus();
    }

    private clearManualErrors() {
        this.$configPanelError!.textContent = '';

        for (const field of ConfigHandler.manualFields) {
            ConfigHandler.manualInput(field.name)?.classList.remove('input--invalid');
        }
    }

    // Drops a stale message once the user starts correcting the field it refers to.
    private readonly onManualFieldInput = (event: Event) => {
        (event.target as HTMLInputElement).classList.remove('input--invalid');

        this.$configPanelError!.textContent = '';
    };

    async handleRegisterDisplayCallback() {
        try {
            await window.apiHandler.xmdsTryRegister(this.config);

            // Close the config panel.
            this.$configPanel?.style.setProperty('display', 'none');

            if (this.reopened) {
                // The player is already running against the previous CMS. Re-running
                // main's startup path here would have main push `configure` back down
                // and the renderer would spin up a second XLR instance on top of the
                // first, so reload and let the normal boot sequence pick up the new CMS.
                console.debug('[ConfigHandler] CMS details changed, reloading the renderer');
                window.location.reload();
                return;
            }

            await this.runApp({ context: 'main' });
        } catch (error) {
            console.debug('[ConfigHandler::handleRegisterDisplayCallback]', error);

            const reqError = error;

            if (reqError instanceof Error) {
                this.$configPanelError!.textContent = reqError.message;
            } else {
                console.debug(reqError);
            }
        }
    }

    handleCodeInterval(response: { data: { user_code: string; device_code: string } }) {
        console.debug(response);

        this.$configPanelCode?.style.setProperty('display', 'grid');
        this.$configPanelManual?.style.setProperty('display', 'none');
        this.$activePage?.style.setProperty('display', 'flex');
        this.$inactivePage?.style.setProperty('display', 'none');
        this.$unavailableCode?.style.setProperty('display', 'none');

        const $configPanelCodeText = (<HTMLElement>this.$configPanelCode!.getElementsByTagName('code')[0]);
        const $hideCodeCheckbox = (<HTMLInputElement>this.$configPanelCode!.querySelector('.hide-code--wrapper input[type="checkbox"]'))

        $configPanelCodeText.textContent = response.data.user_code;

        if ($hideCodeCheckbox) {
            $hideCodeCheckbox.checked = false;
        }

        this.hideCodeCheckboxHandler($configPanelCodeText.textContent);

        // Periodic polling to get the device code and configure the connection.
        this.codeInterval = setInterval(() => {
            axios.get('https://auth.signlicence.co.uk/getDetails?user_code='
                + response.data.user_code + "&device_code=" + response.data.device_code)
                .then(async (response: AxiosResponse) => {
                    console.debug(response.data);

                    // If we get a message back, continue on.
                    if (response.data.message) {
                        return;
                    }

                    clearInterval(this.codeInterval);
                    this.codeInterval = undefined;

                    // The response should contain the cmsKey.
                    const claimedCmsUrl = response.data.cmsAddress;
                    const claimedCmsKey = response.data.cmsKey;

                    console.debug('ConfigHandler::handleCodeInterval - Got config from code polling', {
                        cmsKey: claimedCmsKey,
                        cmsUrl: claimedCmsUrl,
                    });

                    // On a player that is already registered the claim was completed by
                    // whoever added the code at a CMS, not by the person standing at the
                    // display. Two things must not happen silently in that case.
                    if (this.reopened) {
                        // Nothing to change — re-registering would be a pointless round
                        // trip and a needless reload of a player that is already running.
                        if (this.isSameCms(claimedCmsUrl, claimedCmsKey)) {
                            console.debug('ConfigHandler::handleCodeInterval - Claimed by the CMS already in use, nothing to do');
                            this.showClaimAlreadyConnected(claimedCmsUrl);
                            return;
                        }

                        // A different CMS, so this would disconnect a working display.
                        // Get a human to agree to it first.
                        this.showClaimReview(claimedCmsUrl, claimedCmsKey);
                        return;
                    }

                    this.applyClaim(claimedCmsUrl, claimedCmsKey);
                    await this.handleRegisterDisplayCallback();
                });
        }, this.codeChangeInterval * 1000);
    }

    /** Trailing slashes and stray whitespace shouldn't read as a different CMS. */
    private static normaliseCmsUrl(url: string | undefined) {
        return (url ?? '').trim().replace(/\/+$/, '');
    }

    /**
     * True when a claim resolves to the CMS and key this player already uses. A rotated
     * key still counts as a change, because the player has to re-register to pick it up.
     */
    private isSameCms(cmsUrl: string, cmsKey: string) {
        return ConfigHandler.normaliseCmsUrl(cmsUrl) === ConfigHandler.normaliseCmsUrl(this.config.cmsUrl)
            && cmsKey.trim() === (this.config.cmsKey ?? '').trim();
    }

    /** Moves claimed CMS details onto the config, ready to register with. */
    private applyClaim(cmsUrl: string, cmsKey: string) {
        this.config.cmsUrl = cmsUrl;
        this.config.cmsKey = cmsKey;

        // Keep whatever the display is already called. Only a player being registered for
        // the first time has no name to keep.
        this.config.displayName = this.config.displayName || this.config.platform + ' Unknown player';
    }

    /** Asks the user to confirm a CMS move before it is committed. */
    private showClaimReview(cmsUrl: string, cmsKey: string) {
        this.pendingClaim = { cmsUrl, cmsKey };

        if (this.$claimReviewTitle) {
            this.$claimReviewTitle.textContent = 'Move this display to another CMS?';
        }

        if (this.$claimReviewMessage) {
            this.$claimReviewMessage.textContent = 'This activation code was claimed by a different CMS. '
                + 'Connecting will disconnect this display from the CMS it is using now.';
        }

        this.$claimReviewNewRow?.style.removeProperty('display');
        this.$claimReviewAccept?.style.removeProperty('display');

        if (this.$claimReviewCancel) {
            this.$claimReviewCancel.textContent = 'Cancel';
        }

        this.renderClaimReview(cmsUrl);
    }

    /** Reports a claim that resolved to the CMS already in use, having changed nothing. */
    private showClaimAlreadyConnected(cmsUrl: string) {
        this.pendingClaim = null;

        if (this.$claimReviewTitle) {
            this.$claimReviewTitle.textContent = 'Already connected to this CMS';
        }

        if (this.$claimReviewMessage) {
            this.$claimReviewMessage.textContent = 'The activation code was claimed by the CMS this display '
                + 'already uses, so nothing has changed.';
        }

        // No move to accept, and only one CMS worth naming.
        this.$claimReviewNewRow?.style.setProperty('display', 'none');
        this.$claimReviewAccept?.style.setProperty('display', 'none');

        if (this.$claimReviewCancel) {
            this.$claimReviewCancel.textContent = 'Back';
        }

        this.renderClaimReview(cmsUrl);
    }

    private renderClaimReview(cmsUrl: string) {
        if (this.$claimReviewCurrent) {
            this.$claimReviewCurrent.textContent = this.config.cmsUrl ?? 'Not connected';
        }

        if (this.$claimReviewNew) {
            this.$claimReviewNew.textContent = cmsUrl;
        }

        this.$activePage?.style.setProperty('display', 'none');
        this.$inactivePage?.style.setProperty('display', 'block');
        this.$unavailableCode?.style.setProperty('display', 'none');
        this.$claimReview?.style.setProperty('display', 'flex');
    }

    private hideClaimReview() {
        this.pendingClaim = null;
        this.$claimReview?.style.setProperty('display', 'none');
    }

    /** Writes the activation code on screen, respecting the "Hide" toggle. */
    private setActivationCodeText(code: string | null) {
        const $codeText = this.$configPanel?.querySelector('code.code-text');
        const $hideCode = this.$configPanel?.querySelector<HTMLInputElement>('.hide-code--wrapper input[type="checkbox"]');

        this.activationCode = code;

        if ($codeText) {
            $codeText.textContent = code && $hideCode?.checked ? '••••••' : code;
        }
    }

    private readonly onClaimAccept = async () => {
        if (this.pendingClaim === null) {
            return;
        }

        const { cmsUrl, cmsKey } = this.pendingClaim;

        // Registers here rather than through handleRegisterDisplayCallback, because a
        // failure has to surface in this panel — the usual error slot lives in
        // .active-page, which is hidden while the review is up.
        const previous = { cmsUrl: this.config.cmsUrl, cmsKey: this.config.cmsKey, displayName: this.config.displayName };

        if (this.$claimReviewAccept) {
            this.$claimReviewAccept.disabled = true;
        }

        if (this.$claimReviewMessage) {
            this.$claimReviewMessage.textContent = 'Connecting…';
        }

        this.applyClaim(cmsUrl, cmsKey);

        try {
            await window.apiHandler.xmdsTryRegister(this.config);
        } catch (error) {
            console.debug('[ConfigHandler::onClaimAccept] Registration failed', error);

            // Put the old details back so the user can retry or walk away unchanged.
            Object.assign(this.config, previous);

            if (this.$claimReviewMessage) {
                this.$claimReviewMessage.textContent = error instanceof Error
                    ? error.message
                    : 'Could not connect to that CMS.';
            }

            if (this.$claimReviewAccept) {
                this.$claimReviewAccept.disabled = false;
            }

            return;
        }

        this.pendingClaim = null;

        // The player is still running against the old CMS, so reload and let the normal
        // boot sequence come up on the new one.
        console.debug('[ConfigHandler::onClaimAccept] Moved CMS, reloading the renderer');
        window.location.reload();
    };

    /**
     * Declines the claim and goes back to waiting. The code that was just claimed is
     * spent, so run() mints a fresh one.
     */
    private readonly onClaimCancel = async () => {
        console.debug('[ConfigHandler] Claim declined, returning to the activation code');
        await this.run();
    };

    /** Resets the page to "waiting for an activation code" before a code is fetched. */
    private showActivationPanel() {
        this.hideClaimReview();

        this.$activePage?.style.setProperty('display', 'flex');
        this.$inactivePage?.style.setProperty('display', 'none');
        this.$unavailableCode?.style.setProperty('display', 'none');
        this.$configPanelCode?.style.setProperty('display', 'grid');
        this.$configPanelManual?.style.setProperty('display', 'none');
        this.$configPanelError!.textContent = '';

        this.$useCodeButton?.classList.add('active');
        this.$manualConnectButton?.classList.remove('active');
    }

    handleManualConnect() {
        // Show manual configuration instead.
        this.hideClaimReview();
        this.$activePage?.style.setProperty('display', 'flex');
        this.$inactivePage?.style.setProperty('display', 'none');
        this.$configPanelCode?.style.setProperty('display', 'none');
        this.$configPanelManual?.style.setProperty('display', 'grid');

        const $hideCmsKeyCheckbox = (<HTMLInputElement>this.$configPanelCode!.querySelector('.hide-cmsKey--wrapper input[type="checkbox"]'))

        if ($hideCmsKeyCheckbox) {
            $hideCmsKeyCheckbox.checked = false;
        }

        this.hideCmsKeyCheckboxHandler();
    }

    /**
     * Reopens the page over live playback on a player that is already registered, so a
     * CMS address or key can be corrected on-device.
     *
     * Behaves like the first-boot page: it lands on the activation code and starts
     * polling. The manual tab is pre-filled with the current details.
     *
     * What differs is what happens when a claim lands. On first boot the player has
     * nothing to lose, so the claim commits straight away. Here it does not, because the
     * claim is completed by whoever entered the code at a CMS rather than by the person
     * at the display — see the guards in handleCodeInterval().
     */
    open(options: ConfigHandlerOpenOptions = {}) {
        this.reopened = true;
        this.onClose = options.onClose;

        this.init();

        // Full-bleed and opaque, since layout content is still playing behind it.
        this.$configPanel!.classList.add('config--overlay');
        this.$configPanel!.style.setProperty('display', 'flex');

        // The activation panel's slideshow needs to be running again — close() stops it.
        this.startSlides();

        if (this.$topHeaderTitle) {
            this.originalHeaderTitle ??= this.$topHeaderTitle.textContent ?? '';
            this.$topHeaderTitle.textContent = 'Player configuration';
        }

        // Pre-fill so only the field being corrected has to be retyped.
        (<HTMLInputElement>document.getElementsByName('display-name')[0]).value = this.config.displayName ?? '';
        (<HTMLInputElement>document.getElementsByName('cms-address')[0]).value = this.config.cmsUrl ?? '';
        (<HTMLInputElement>document.getElementsByName('cms-key')[0]).value = this.config.cmsKey ?? '';

        this.clearManualErrors();

        // A way back to playback. Not offered during first-boot registration, where
        // there is nothing to go back to.
        if (this.$closeButton) {
            this.$closeButton.style.setProperty('display', 'block');
            this.$closeButton.removeEventListener('click', this.close);
            this.$closeButton.addEventListener('click', this.close);
        }

        document.removeEventListener('keydown', this.onKeydown);
        document.addEventListener('keydown', this.onKeydown);

        // Same as a fresh setup: show the activation code and start polling for a claim.
        return this.run();
    }

    /**
     * Dismisses a reopened page and hands control back to the nav bar, leaving the CMS
     * details as they were.
     */
    readonly close = () => {
        if (!this.reopened) {
            return;
        }

        document.removeEventListener('keydown', this.onKeydown);
        this.$closeButton?.removeEventListener('click', this.close);
        this.$closeButton?.style.setProperty('display', 'none');

        // Stop the activation-code poll and the slideshow, in case either ever started.
        if (this.codeInterval !== undefined) {
            clearInterval(this.codeInterval);
            this.codeInterval = undefined;
        }

        if (this.timeoutId !== undefined) {
            clearTimeout(this.timeoutId);
            this.timeoutId = undefined;
        }

        this.$configPanel?.classList.remove('config--overlay');
        this.$configPanel?.style.setProperty('display', 'none');

        // Drop the code that was on screen. It expires with the poll we just cancelled,
        // so the next open must not flash it while a fresh one is being fetched.
        this.setActivationCodeText(null);

        // Abandon any claim the user neither accepted nor declined.
        this.hideClaimReview();

        if (this.$topHeaderTitle && this.originalHeaderTitle !== undefined) {
            this.$topHeaderTitle.textContent = this.originalHeaderTitle;
        }

        this.onClose?.();
    };

    /**
     * Escape closes a reopened page. Handled at the document level because the config
     * page has no single element that reliably holds focus.
     */
    private readonly onKeydown = (event: KeyboardEvent) => {
        if (event.key.toLowerCase() !== 'escape') {
            return;
        }

        event.preventDefault();
        this.close();
    };

    async run() {
        // Back to a clean waiting state. Blank the old code so a spent one can't sit on
        // screen while the replacement is being fetched.
        this.showActivationPanel();
        this.setActivationCodeText('');

        await this.licenseGenerateCode()
            .catch((error) => {
                console.debug(error);

                this.$activePage?.style.setProperty('display', 'none');
                this.$inactivePage?.style.setProperty('display', 'block');
                this.$unavailableCode?.style.setProperty('display', 'flex');
            });
    }

    async licenseGenerateCode() {
        return axios.post('https://auth.signlicence.co.uk/generateCode', {
            hardwareId: this.config.hardwareKey,
            type: 'linux',
            version: this.config.version
        })
            .then((response) => {
                console.debug('ConfigHandler::licenseGenerateCode', response);
                this.handleCodeInterval(response);
            });
    }

    private readonly onHideCodeChange = (event: Event) => {
        const $checkbox = event.target as HTMLInputElement;
        const $hideCodeText = (<HTMLElement>this.$configPanel!.querySelector('code.code-text'));

        $hideCodeText.textContent = $checkbox.checked ? "••••••" : this.activationCode;
    };

    hideCodeCheckboxHandler(activationCode: string | null) {
        const $hideCodeElm = (<HTMLElement>this.$configPanel!.querySelector('.hide-code--wrapper'));
        const $hideCodeCheckbox = (<HTMLInputElement>$hideCodeElm!.querySelector('input[type="checkbox"]'));

        // Read from the instance rather than closing over the argument, so a refreshed
        // code doesn't need a new listener. Every code refresh used to add one.
        this.activationCode = activationCode;

        $hideCodeCheckbox.removeEventListener('change', this.onHideCodeChange);
        $hideCodeCheckbox.addEventListener('change', this.onHideCodeChange);
    }

    private readonly onHideCmsKeyChange = (event: Event) => {
        const $checkbox = event.target as HTMLInputElement;
        const $cmsKeyInput = (<HTMLInputElement>document.getElementsByName('cms-key')[0]);

        $cmsKeyInput.type = $checkbox.checked ? 'password' : 'text';
    };

    hideCmsKeyCheckboxHandler() {
        const $hideCmsKeyElm = (<HTMLElement>this.$configPanel!.querySelector('.hide-cmsKey--wrapper'));
        const $hideCmsKeyCheckbox = (<HTMLInputElement>$hideCmsKeyElm!.querySelector('input[type="checkbox"]'));

        // An instance-bound handler, so reopening the page replaces the listener rather
        // than adding a second one.
        $hideCmsKeyCheckbox.removeEventListener('change', this.onHideCmsKeyChange);
        $hideCmsKeyCheckbox.addEventListener('change', this.onHideCmsKeyChange);
    }

    /**
     * Wires the slideshow dots. Called once from init(), because showSlides() re-runs
     * every five seconds and adding the listeners there piled up one per dot per tick.
     */
    initSlideDots() {
        const dots = Array.from(<HTMLCollectionOf<HTMLElement>>document.getElementsByClassName("dot"));

        dots.forEach((dot, dotIndex) => {
            const dotSlide = parseInt(dot.dataset.slide ?? String(dotIndex + 1));
            dot.addEventListener('click', () => this.currentSlide(dotSlide));
        });
    }

    /** Restarts the slideshow from the top, without leaving a second chain running. */
    startSlides() {
        if (this.timeoutId !== undefined) {
            clearTimeout(this.timeoutId);
            this.timeoutId = undefined;
        }

        this.slideIndex = 0;
        this.showSlides();
    }

    showSlides() {
        const self = this;
        let slides = Array.from(<HTMLCollectionOf<HTMLElement>>document!.getElementsByClassName("mySlides"));
        let dots = Array.from(<HTMLCollectionOf<HTMLElement>>document!.getElementsByClassName("dot"));

        (async () => await Promise.all(slides.map((slide) => slide.style.display = 'none')))();

        this.slideIndex++;
        if (this.slideIndex > slides.length) {
            this.slideIndex = 1;
        }

        dots.forEach((dot) => dot.classList.remove('active'));

        const currSlideIndex = this.slideIndex - 1;

        (Boolean(slides[currSlideIndex])) && slides[currSlideIndex].style.setProperty('display', 'block');
        (Boolean(dots[currSlideIndex])) && dots[currSlideIndex].classList.add('active');

        self.timeoutId = setTimeout(this.showSlides.bind(self), 5000);
    }

    currentSlide(n: number) {
        this.slideIndex = n;

        if (this.timeoutId !== undefined) {
            clearTimeout(this.timeoutId);
        }

        this.showSlides();
    }

    setConfigDetails() {
        const $dateTimeTxt = (<HTMLElement>this.$configPanel!.querySelector('#date-time--text'));
        const $dateTimeTxt2 = (<HTMLElement>this.$configPanel!.querySelector('#date-time--text2'));

        const dateTimeNow = DateTime.now().toFormat('FF');

        if ($dateTimeTxt) {
            $dateTimeTxt.textContent = dateTimeNow;
        }

        if ($dateTimeTxt2) {
            $dateTimeTxt2.textContent = dateTimeNow;
        }
    }
}