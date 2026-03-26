import { Command } from "../../main/command/command";

type CommandProps = {
  commandCode: string
  commandString: string
  commandType: string
  commandParams: string[]
  validationString: string
  createAlertOn: string
}

type CommandResult = void | string;

export type CommandCollectionItem = {
  commandString: string;
  createAlertOn: string;
  validationString: string;
};

export type CommandsCollection = {
  [commandCode: string]: CommandCollectionItem;
};

/**
 * Manages command handling and execution for the player.
 *
 * This class is responsible for parsing commands received from the CMS,
 * registering local command handlers, executing commands immediately or
 * at scheduled times, and reporting command success or failure.
 *
 * Commands can be executed by command code or raw command string, and
 * scheduled commands are handled using timed execution based on their
 * provided dates.
 *
 * Public methods:
 * - `parseCommands()` - parses command definitions from the CMS XML.
 * - `registerCommand()` - registers a local handler for a command type.
 * - `executeCommandByCode()` - executes a command using its CMS command code.
 * - `executeCommandByString()` - executes a command from a raw encoded string.
 * - `scheduleCommands()` - schedules commands to run at specific times.
 */
export class CommandManager {
  private commands: {
    [commandCode: string]: CommandProps
  } = {};

  private registeredPlayerCommands: {
    [commandType: string]: (...params: string[]) => Promise<CommandResult>
  } = {};

  private scheduledTimeouts: number[] = [];

  /**
   * Parses a display registration response, extracts available commands from the XML,
   * builds an internal command map, and prepares them for later execution.
   *
   * @param response
   */
  public parseCommands(collection: CommandsCollection) {

    if (!Object.keys(collection).length) {
      console.debug('[CommandManager] No commands found');
      return;
    }

    this.commands = {};

    for (const [commandCode, commandData] of Object.entries(collection)) {
      const { commandString, createAlertOn, validationString } = commandData;

      const parts = commandString.split('|');
      const commandType = parts[0] ?? '';
      const commandParams = parts.slice(1);


      this.commands[commandCode] = {
        commandCode,
        commandString,
        commandType,
        commandParams,
        validationString,
        createAlertOn
      };
    }

    console.debug('[CommandManager] Commands parsed:', {
      commands: Object.keys(this.commands)
    });
  }

  /**
   * Registers a local/player-specific command for a specific command type,
   * so it can be executed when a matching command is received.
   *
   * @param commandType The local/player-specific command identifier
   * @param callback The function to execute for the given command type
   */
  public registerCommand(commandType: string, callback: (...params: string[]) => Promise<CommandResult>) {
    this.registeredPlayerCommands[commandType] = callback;

    console.debug('[CommandManager] Registered local command', {
      commandType,
    });
  }

  /**
   * Executes a command using its CMS-provided command code.
   *
   * The command must have been previously parsed and stored
   * before it can be executed.
   *
   * @param commandCode
   */
  public async executeCommandByCode(commandCode: string) {
    const command = this.commands[commandCode];

    if (!command) {
      console.error('[CommandManager] Unknown command code', { commandCode });
      return;
    }

    await this.executeCommand(command);
  }

  /**
   * Executes a command from an encoded command string by decoding it,
   * extracting the command type and parameters, and running the command.
   *
   * @param encodedCommandString
   */
  public async executeCommandByString(encodedCommandString: string) {
    if (!encodedCommandString) {
      console.error('[CommandManager] Empty command string');
      return;
    }

    const commandString = decodeURIComponent(encodedCommandString);

    const parts = commandString.split('|');
    const commandType = parts[0] ?? '';
    const commandParams = parts.slice(1);

    const command: CommandProps = {
      commandCode: '',
      commandString,
      commandType,
      commandParams,
      validationString: '',
      createAlertOn: 'never'
    };

    await this.executeCommand(command);
  }

  /**
   * Executes a resolved command by looking up its registered local command,
   * running it with the provided parameters, and handling success or failure
   * based on the command’s validation rules.
   *
   * @param command
   * @private
   */
  private async executeCommand(command: CommandProps) {
    console.debug('[CommandManager] Executing command', {
      commandType: command.commandType
    });

    let result: CommandResult;

    try {
      // Lookup local command handler by commandType
      const handler = this.registeredPlayerCommands[command.commandType];

      if (!handler) {
        throw new Error(`Unsupported command type: ${command.commandType}`);
      }

      // Execute the command and pass the parameters, if any
      result = await handler(...command.commandParams);

      if (command.validationString) {
        if (typeof result === 'string' && result === command.validationString) {
          this.handleCommandSuccess(command);
        } else {
          this.handleCommandFailure(
              'Command was executed but did not match the validation string',
              command
          );
        }
      } else {
        this.handleCommandSuccess(command);
      }
    } catch (error) {
      this.handleCommandFailure(error, command);
    }
  }

  /**
   * Schedules commands for future execution by registering timed callbacks.
   * Clears any previously scheduled executions before scheduling new ones.
   *
   * @param commands
   */
  public scheduleCommands(commands: Command[]) {
    if (commands.length === 0) {
      console.debug('[CommandManager] No scheduled commands found');
      return;
    }

    // Clear any previously scheduled commands
    this.scheduledTimeouts.forEach(timeoutId => clearTimeout(timeoutId));
    this.scheduledTimeouts = [];

    const now = Date.now();

    for (const command of commands) {
      const executeAt = new Date(command.date).getTime();
      const delay = executeAt - now;

      // Ignore commands scheduled in the past
      if (delay <= 0) {
        console.debug('[CommandManager] Skipping expired scheduled command', command.code);
        continue;
      }

      // Schedule the command to execute once at the exact provided time
      const timeoutId = window.setTimeout(async () => {
        console.debug('[CommandManager] Executing scheduled command', command.code);
        await this.executeCommandByCode(command.code);
      }, delay);

      // Store the timeout reference, so it can be cancelled if the schedule updates
      this.scheduledTimeouts.push(timeoutId);
    }

    console.debug('[CommandManager] Commands scheduled', {
      count: this.scheduledTimeouts.length,
    });
  }

  /**
   * Handles a successful command execution and triggers any configured alerts
   * based on the command’s alert settings.
   *
   * @param command
   * @private
   */
  private handleCommandSuccess(command: CommandProps) {
    console.debug('[CommandManager] Command executed successfully', {
      commandType: command.commandType
    });

    if (command.createAlertOn === 'success' || command.createAlertOn === 'always') {
      console.alert(`Command ${command.commandType} executed successfully`, {
        shouldParse: false,
        eventType: 'Command',
        alertType: 'both',
      });
    }
  }

  /**
   * Handles a failed command execution by logging the error and triggering
   * any configured failure alerts for the command.
   *
   * @param error
   * @param command
   * @private
   */
  private handleCommandFailure(error: unknown, command?: CommandProps) {
    console.error('[CommandManager] Command execution failed', {
      commandType: command?.commandType,
      error
    });

    if (!command) {
      console.alert('Command not found', {
        shouldParse: false,
        eventType: 'Command',
        alertType: 'both',
      });
      return;
    }

    if (command.createAlertOn === 'failure' || command.createAlertOn === 'always') {
      console.alert(`Command ${command.commandType} failed to execute`, {
        shouldParse: false,
        eventType: 'Command',
        alertType: 'both',
      });
    }
  }
}

export const commandManager = new CommandManager();
