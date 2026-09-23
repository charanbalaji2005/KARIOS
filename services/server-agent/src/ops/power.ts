/**
 * Reboot and shutdown.
 *
 * Both are scheduled a minute out rather than executed immediately, for two
 * reasons. The obvious one: an immediate reboot kills the process before it
 * can tell the dashboard it worked, so the operator is left staring at a
 * spinner wondering whether the request landed. The better one: a minute is
 * long enough to cancel, and `server_power_cancel` exists precisely because
 * "wait, not that machine" is a thought people have about four seconds after
 * clicking.
 */
import { register } from '../registry.js';
import { run, binaryAvailable } from '../exec.js';
import { reportAllServices } from './services.js';

/** Minutes between the request and the machine actually going down. */
const DELAY_MINUTES = 1;

async function schedule(mode: 'reboot' | 'shutdown', message: string): Promise<string> {
  if (!binaryAvailable('shutdown')) {
    throw new Error('`shutdown` is not available on this host.');
  }
  // `shutdown -r +1 "message"` — argv, so the message is a message and not a
  // second command however it is worded.
  const flag = mode === 'reboot' ? '-r' : '-h';
  const result = await run('shutdown', [flag, `+${DELAY_MINUTES}`, message], {
    timeoutMs: 15_000,
    allowNonZeroExit: true,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `shutdown exited ${result.code}`);
  }
  return (result.stderr || result.stdout).trim();
}

register(
  {
    id: 'server_reboot',
    summary: 'Reboot the host in one minute',
    category: 'power',
    danger: true,
    confirmPhrase: 'REBOOT SERVER',
    timeoutMs: 30_000,
    async run({ emit }) {
      // Say what is about to be interrupted. On this product the machine is
      // someone's laptop and the database on it may be mid-write.
      const services = await reportAllServices();
      const running = services.filter((service) => service.state === 'running');
      emit(`${running.length} services are running and will stop: ${running.map((s) => s.label).join(', ')}\n`);

      const output = await schedule('reboot', 'KAIROS: reboot requested from the admin panel');

      return {
        data: {
          scheduled: true,
          mode: 'reboot',
          delayMinutes: DELAY_MINUTES,
          at: new Date(Date.now() + DELAY_MINUTES * 60_000).toISOString(),
          cancellable: true,
        },
        text: [
          output,
          '',
          `Reboot scheduled for ${DELAY_MINUTES} minute from now.`,
          'Run `kairos server power cancel`, or the Cancel button, to call it off.',
          '',
          'On the way back up: Docker restarts its containers, the agent restarts under systemd,',
          'and the firewall reloads from /etc/kairos/nftables.conf. Data on the volume is untouched.',
        ].join('\n'),
      };
    },
  },
  {
    id: 'server_shutdown',
    summary: 'Power the host off in one minute',
    category: 'power',
    danger: true,
    confirmPhrase: 'SHUTDOWN SERVER',
    timeoutMs: 30_000,
    async run({ emit }) {
      emit('This powers off the machine. If it is not physically in front of you, nothing here can turn it back on.\n');
      const output = await schedule('shutdown', 'KAIROS: shutdown requested from the admin panel');
      return {
        data: {
          scheduled: true,
          mode: 'shutdown',
          delayMinutes: DELAY_MINUTES,
          at: new Date(Date.now() + DELAY_MINUTES * 60_000).toISOString(),
          cancellable: true,
        },
        text: `${output}\n\nShutdown scheduled for ${DELAY_MINUTES} minute from now. Cancel it now if this is the wrong machine.`,
      };
    },
  },
  {
    id: 'server_power_cancel',
    summary: 'Cancel a scheduled reboot or shutdown',
    category: 'power',
    danger: false,
    timeoutMs: 15_000,
    async run() {
      if (!binaryAvailable('shutdown')) throw new Error('`shutdown` is not available on this host.');
      const result = await run('shutdown', ['-c'], { timeoutMs: 10_000, allowNonZeroExit: true });
      // `shutdown -c` exits non-zero when there was nothing scheduled, which
      // is a perfectly good answer to "cancel it".
      const nothingScheduled = result.code !== 0;
      return {
        data: { cancelled: !nothingScheduled },
        text: nothingScheduled ? 'Nothing was scheduled.' : 'Cancelled. The machine stays up.',
      };
    },
  },
);
